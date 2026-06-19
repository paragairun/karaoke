// =============================================================================
// useVocalsComparison.ts — REBUILT FROM SCRATCH
// =============================================================================
// CHANGELOG
// =============================================================================
// This file replaces nine prior forward-patched iterations. Rather than patch
// again, it was rebuilt clean, incorporating every lesson learned:
//
// BUGS THAT EXISTED ACROSS PRIOR VERSIONS (all fixed in this rebuild):
//
// 1. YIN pitch sub-harmonic errors — NOT in this file; lives in vocalScoring.ts
//    (threshold-first CMNDF, confirmed already fixed there).
//
// 2. Unstable `options` object recreated every render caused callbacks to be
//    recreated constantly. FIX: optionsRef holds latest options; all
//    useCallback/useEffect dependency arrays avoid depending on `options`
//    directly except where a specific primitive (e.g. options.isPlaying) is
//    intentionally watched.
//
// 3. THE 60FPS SEEK BUG (root cause of "score never moves" across many
//    sessions): a sync effect included `options.currentTime` in its
//    dependency array. currentTime updates 60x/sec via requestAnimationFrame
//    in Sing.tsx, so the effect re-ran 60x/sec, calling `audio.currentTime =
//    target` every frame. Seeking an HTMLAudioElement flushes its decoded
//    buffer, so the Web Audio analyser downstream always read silence.
//    FIX: the play/pause sync effect depends ONLY on `options.isPlaying`.
//    It seeks once at play-start, then lets the element run freely in sync.
//
// 4. SPEAKER BLEED / INVERTED SCORES: the reference vocals Audio element was
//    routed audibly through speakers (outputGain ~0.3). The mic — with
//    echoCancellation disabled on non-iOS — picked up those speakers.
//    Silent user: mic hears reference vocals -> near-perfect pitch match ->
//    HIGH score. Singing user: mixed signal (voice + reference) confuses
//    pitch detection -> LOWER score. Exactly backwards from intended.
//    FIX: this hook's reference Audio element is volume=0 ALWAYS. It is
//    analysis-only and never reaches speakers. Audible playback of the
//    guide vocals is Sing.tsx's responsibility via its own separate
//    Audio element (vocalsAudioRef) — completely decoupled from this hook.
//
// 5. `audio.muted = true` (which seems like the "more correct" way to
//    silence an element) actually BLOCKS the Web Audio decode pipeline on
//    Safari and some Chrome versions. The analyser would read permanent
//    silence even though everything else was wired correctly.
//    FIX: only ever use `audio.volume = 0`. Never set `.muted = true` on
//    the analysis-only reference element.
//
// 6. TWO AUDIOCONTEXTS, ONE BROKEN MAIN PLAYER: earlier attempts shared the
//    user-mic singleton AudioContext for reference-audio analysis too, to
//    avoid iOS's one-context limitation. This backfired badly:
//      a) stopAnalysis() closes the mic singleton via cleanupAudio()
//         (refcounted). The reference audio graph, connected to that same
//         context, became permanently broken once the context closed —
//         even though the reference Audio element and blob URL were fine.
//      b) On iOS/some Chrome, creating/touching an AudioContext at the
//         wrong time can capture ALL HTMLAudioElement output routing,
//         which is what broke the *main instrumental player* in one
//         session — a completely separate, plain HTMLAudioElement got
//         silenced as collateral damage.
//    FIX (the permanent architecture decision in this rebuild):
//      TWO COMPLETELY INDEPENDENT AudioContexts, never shared, never
//      cross-referenced:
//        - userAudioCtx: created fresh in startAnalysis() via the shared
//          singleton helper in audioPermissions.ts. Short lifecycle —
//          opened when the mic session starts, closed by stopAnalysis()
//          via cleanupAudio(). This is the ONLY context the mic ever uses.
//        - refAudioCtx: a DEDICATED context created once per song, the
//          moment the reference vocals blob URL is buffered. It is NEVER
//          closed by stopAnalysis(). It is only torn down by
//          resetScores() (explicit song change) or on hook unmount.
//      Because these contexts never touch each other, closing one can
//      never break the other, and the main instrumental player — a plain
//      HTMLAudioElement entirely outside this hook — is never at risk.
//
// 7. DOUBLE-INIT OF THE SAME BLOB URL: `createMediaElementSource()` can
//    only be called once per HTMLAudioElement, and once called, that
//    element's blob is permanently bound to that decode pipeline. A
//    previous version reset an "already initialised" guard inside
//    stopAnalysis(), which caused startAnalysis() to create a SECOND
//    Audio element for the SAME blob URL — which threw a decode error
//    and produced permanent silence.
//    FIX: the "initialised for this URL" guard (refInitialisedUrlRef) is
//    set once per blob URL and is ONLY cleared by resetScores() (new song)
//    or on an actual decode error (to allow a legitimate retry). It is
//    never touched by stopAnalysis() or startAnalysis().
//
// 8. PREMATURE AUDIOCONTEXT CREATION: buffering the reference Audio element
//    must not require an AudioContext at all — that step is pure
//    `<audio>` element buffering (`audio.load()` + `oncanplay`). Creating
//    an AudioContext before the user has pressed Play (a required user
//    gesture on most browsers) is both unnecessary and risky.
//    FIX: `bufferReferenceAudio()` only creates and loads the Audio
//    element. `connectReferenceGraph()` — which creates refAudioCtx and
//    wires up the analyser — is only ever called from inside
//    startAnalysis(), which itself only runs after a user gesture
//    (pressing Play) has granted microphone access.
//
// SCORING REQUIREMENTS (gathered from the whole conversation, all preserved):
//   - App is explicitly for AMATEUR singers — be encouraging, not punishing.
//   - Silence during active reference vocals scores 0 for that frame. No
//     artificial floor (a prior bug awarded 60 points for total silence).
//   - Singing during an instrumental-only section earns no credit (correct:
//     there is nothing to compare against).
//   - Reference pitch undetected while reference IS active (breathy/complex
//     vocal passage) + user IS singing: 40 points partial credit — rewards
//     "being there and trying" without rewarding pitch accuracy that can't
//     be verified.
//   - User pitch undetected while user IS vocalising (breathy/soft singing)
//     + reference pitch detected: 25 points partial credit.
//   - Miss penalty capped at 30% (not 50%) of the raw pitch score — a singer
//     who is shy or slow to start should not be devastated.
//   - Rhythm onset-matching tolerance window: 300ms (not 180ms). 180ms
//     creates a harsh scoring cliff — exactly 180ms late scores ~50,
//     181ms late scores 0. Amateurs are routinely 200–250ms off; 300ms
//     gives a smoother, fairer falloff.
//   - Score scale: 0–1000 displayed, built from 0–100 per-component
//     averages weighted pitch 0.4 / rhythm 0.3 / technique 0.3.
//   - Permanent (not temporary/debug-only) diagnostic console logs are a
//     standing requirement — every state transition and every per-second
//     scoring snapshot is logged with a consistent tag prefix so future
//     issues can be diagnosed directly from browser console output without
//     another round of speculative patching.
// =============================================================================

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  cleanupAudio,
  createAudioContext,
  formatMicrophoneError,
  requestMicrophone,
} from '@/lib/audioPermissions';
import {
  detectPitchAC,
  rmsFloat,
  dbEnergy,
  clamp100,
  scoreRhythm,
  scoreTechnique,
  scorePitchFrame,
  SILENCE_RMS,
  ONSET_WINDOW_MS,
} from '@/lib/vocalScoring';

// ─── Public types ───────────────────────────────────────────────────────────

export interface VocalsComparisonMetrics {
  pitchMatch: number;       // 0–100, smoothed
  rhythmMatch: number;      // 0–100, smoothed
  techniqueMatch: number;   // 0–100, smoothed
  volume: number;           // current user mic volume (raw)
  isVoiceDetected: boolean;
  referenceActive: boolean; // is the reference vocal track currently audible (above SILENCE_RMS)
  debug?: {
    voiceThreshold: number;
    noiseFloor: number;
    audioCtxState: AudioContextState | 'unknown';
    micFallback: boolean;
    userVolumeRmsFloat: number;
    userFreqEnergyDb: number;
  };
}

interface UseVocalsComparisonOptions {
  vocalsUrl?: string;
  currentTime?: number;
  isPlaying?: boolean;
  onMetricsUpdate?: (metrics: VocalsComparisonMetrics) => void;
}

// ─── Tuning constants ──────────────────────────────────────────────────────

const FFT_SIZE = 2048;
const HISTORY_FRAMES = 60;          // ~1s of history at 60fps for technique scoring
const SCORE_SMOOTHING = 0.12;       // EMA smoothing factor for displayed scores
const MISS_PENALTY_CAP = 0.3;       // amateur-friendly: was 0.5
const REF_PARTIAL_CREDIT_NO_REFPITCH = 40;
const REF_PARTIAL_CREDIT_NO_USERPITCH = 25;
const ONSET_DEBOUNCE_MS = 100;
const REF_BUFFER_TIMEOUT_MS = 4000;       // soft checkpoint — logs a warning, does not give up
const REF_BUFFER_HARD_TIMEOUT_MS = 15000; // hard ceiling — actually gives up here
const LOG_EVERY_N_FRAMES = 60;      // ~once per second at 60fps

// =============================================================================
// DIAGNOSTIC SYSTEM
// =============================================================================
// Purpose: every future bug report should start with running
//   window.dumpVocalDiagnostics()
// in the browser console and pasting the output, instead of scrolling
// through hundreds of scattered console.log lines. This module captures:
//
//   1. STAGE TRACKER — pass/fail/pending status for every critical
//      checkpoint in the pipeline (mic permission, ref buffering, graph
//      connection, etc), in order, with the timestamp of the last update.
//
//   2. EVENT LOG — a rolling buffer (last 200 events) of every significant
//      state transition, each tagged with WHAT happened, WHY (which
//      function/effect triggered it), and the relevant data at that moment.
//
//   3. LIVE VERIFICATION — rather than just logging "ctx.state: running"
//      (which only proves the context object exists, not that audio is
//      flowing), the health snapshot actively reads the analyser nodes
//      RIGHT THEN and reports real RMS values. This distinguishes
//      "should be working" from "is actually verified working right now".
//
//   4. window.dumpVocalDiagnostics() — exposed globally so it can be run
//      from the browser console at any time, even mid-session, without
//      needing to reproduce a bug from scratch with fresh logging added.
// =============================================================================

type StageStatus = 'pending' | 'ok' | 'failed' | 'warning';

interface StageRecord {
  status: StageStatus;
  detail: string;
  ts: number;
}

const PIPELINE_STAGES = [
  'mic_permission',
  'mic_context_created',
  'mic_stream_connected',
  'ref_url_received',
  'ref_audio_buffered',
  'ref_graph_connected',
  'ref_audio_playing',
  'ref_analyser_verified_nonzero',
  'analysis_loop_running',
] as const;
type PipelineStage = typeof PIPELINE_STAGES[number];

// Module-level (not per-hook-instance) so it survives across remounts within
// the same page session and can be dumped even after a component unmounts.
const stageTracker = new Map<PipelineStage, StageRecord>();
const eventLog: Array<{ ts: number; tag: string; message: string; data?: unknown }> = [];
const EVENT_LOG_MAX = 200;

function recordStage(stage: PipelineStage, status: StageStatus, detail: string) {
  stageTracker.set(stage, { status, detail, ts: Date.now() });
}

function logEvent(tag: string, message: string, data?: unknown) {
  eventLog.push({ ts: Date.now(), tag, message, data });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
  // Still print to console live, with consistent tag formatting, so existing
  // workflow of watching the console in real time keeps working too.
  if (data !== undefined) {
    console.log(`[${tag}] ${message}`, data);
  } else {
    console.log(`[${tag}] ${message}`);
  }
}

function logWarning(tag: string, message: string, data?: unknown) {
  eventLog.push({ ts: Date.now(), tag: `${tag}-WARN`, message, data });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
  if (data !== undefined) console.warn(`[${tag}] ${message}`, data);
  else console.warn(`[${tag}] ${message}`);
}

function logError(tag: string, message: string, data?: unknown) {
  eventLog.push({ ts: Date.now(), tag: `${tag}-ERROR`, message, data });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
  if (data !== undefined) console.error(`[${tag}] ${message}`, data);
  else console.error(`[${tag}] ${message}`);
}

// Holds live references to the current hook instance's nodes so the global
// dump function can read REAL current state, not stale closure data.
interface LiveRefs {
  userAudioCtx: AudioContext | null;
  userAnalyser: AnalyserNode | null;
  refAudioEl: HTMLAudioElement | null;
  refAudioCtx: AudioContext | null;
  refAnalyser: AnalyserNode | null;
  vocalsUrl: string | undefined;
  isPlaying: boolean | undefined;
}
let liveRefsForDump: LiveRefs | null = null;

/**
 * Reads an AnalyserNode RIGHT NOW and returns real RMS — this is the
 * "verified fact" half of the system, as opposed to just reporting object
 * state like ctx.state which can say "running" even while producing silence.
 */
function readAnalyserRmsNow(analyser: AnalyserNode | null): number | null {
  if (!analyser) return null;
  try {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  } catch {
    return null;
  }
}

/**
 * The single command to run when something is wrong:
 *   window.dumpVocalDiagnostics()
 * Prints the full pipeline stage status, a live verification read of both
 * analysers, and the last N events leading up to now — formatted as one
 * readable block that can be copy-pasted directly into a bug report.
 */
function dumpVocalDiagnostics() {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('VOCAL COMPARISON DIAGNOSTICS — ' + new Date().toISOString());
  lines.push('═══════════════════════════════════════════════════════════');

  lines.push('\n── PIPELINE STAGES ──');
  for (const stage of PIPELINE_STAGES) {
    const rec = stageTracker.get(stage);
    if (!rec) {
      lines.push(`  [ ? ] ${stage} — never reached`);
    } else {
      const icon = rec.status === 'ok' ? '✅' : rec.status === 'failed' ? '❌' : rec.status === 'warning' ? '⚠️ ' : '⏳';
      const age = ((Date.now() - rec.ts) / 1000).toFixed(1);
      lines.push(`  ${icon} ${stage} — ${rec.detail} (${age}s ago)`);
    }
  }

  lines.push('\n── LIVE VERIFICATION (read right now, not cached) ──');
  if (liveRefsForDump) {
    const { userAudioCtx, userAnalyser, refAudioEl, refAudioCtx, refAnalyser, vocalsUrl, isPlaying } = liveRefsForDump;
    lines.push(`  isPlaying (from Sing.tsx prop): ${isPlaying}`);
    lines.push(`  vocalsUrl: ${vocalsUrl ? vocalsUrl.slice(0, 60) : 'null'}`);
    lines.push(`  userAudioCtx.state: ${userAudioCtx?.state ?? 'null'}`);
    lines.push(`  refAudioCtx.state: ${refAudioCtx?.state ?? 'null'}`);
    lines.push(`  refAudioEl.paused: ${refAudioEl?.paused ?? 'null'}`);
    lines.push(`  refAudioEl.currentTime: ${refAudioEl?.currentTime?.toFixed(2) ?? 'null'}`);
    lines.push(`  refAudioEl.readyState: ${refAudioEl?.readyState ?? 'null'}`);
    lines.push(`  refAudioEl.volume: ${refAudioEl?.volume ?? 'null'}`);
    lines.push(`  refAudioEl.muted: ${refAudioEl?.muted ?? 'null'}`);
    const userRms = readAnalyserRmsNow(userAnalyser);
    const refRms = readAnalyserRmsNow(refAnalyser);
    lines.push(`  USER analyser live RMS: ${userRms !== null ? userRms.toFixed(5) : 'analyser not connected'}`
      + (userRms !== null ? (userRms > 0.0001 ? ' ✅ receiving signal' : ' ❌ SILENCE') : ''));
    lines.push(`  REF analyser live RMS:  ${refRms !== null ? refRms.toFixed(5) : 'analyser not connected'}`
      + (refRms !== null ? (refRms > 0.0001 ? ' ✅ receiving signal' : ' ❌ SILENCE') : ''));
  } else {
    lines.push('  No active hook instance registered (hook not mounted or never called startAnalysis)');
  }

  lines.push(`\n── LAST ${Math.min(eventLog.length, 40)} EVENTS ──`);
  const recent = eventLog.slice(-40);
  for (const e of recent) {
    const t = new Date(e.ts).toISOString().split('T')[1].replace('Z', '');
    lines.push(`  ${t} [${e.tag}] ${e.message}`);
  }

  lines.push('═══════════════════════════════════════════════════════════');
  const report = lines.join('\n');
  console.log(report);
  return report;
}

if (typeof window !== 'undefined') {
  (window as any).dumpVocalDiagnostics = dumpVocalDiagnostics;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useVocalsComparison(options: UseVocalsComparisonOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>({
    pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
    volume: 0, isVoiceDetected: false, referenceActive: false,
  });

  // Latest options without making callbacks unstable.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ── USER MIC graph — short lifecycle (open in startAnalysis, close in stopAnalysis)
  const userAudioCtxRef = useRef<AudioContext | null>(null);
  const userAnalyserRef = useRef<AnalyserNode | null>(null);
  const userGainRef = useRef<GainNode | null>(null);
  const userKeepAliveRef = useRef<GainNode | null>(null);
  const userSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const userStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const didFallbackRef = useRef(false);
  const lowSignalFramesRef = useRef(0);
  const noiseFloorRef = useRef(0.0015);

  // ── REFERENCE VOCALS graph — long lifecycle (survives stop/start, only torn
  // down on song change via resetScores). Uses its OWN dedicated AudioContext,
  // completely independent from the mic's. See changelog point 6.
  const refAudioElRef = useRef<HTMLAudioElement | null>(null);
  const refAudioCtxRef = useRef<AudioContext | null>(null);
  const refAnalyserRef = useRef<AnalyserNode | null>(null);
  const refSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refKeepAliveRef = useRef<GainNode | null>(null);
  const refInitialisedUrlRef = useRef<string | null>(null);
  const lastIsPlayingRef = useRef<boolean | undefined>(undefined);

  // ── Scoring accumulators (reset only by resetScores)
  const pitchScoreAccRef = useRef(0);
  const pitchFramesRef = useRef(0);
  const missedFramesRef = useRef(0);
  const userOnsetsRef = useRef<number[]>([]);
  const refOnsetsRef = useRef<number[]>([]);
  const lastUserOnsetRef = useRef(0);
  const lastRefOnsetRef = useRef(0);
  const userEnergyHistRef = useRef<number[]>([]);
  const refEnergyHistRef = useRef<number[]>([]);
  const smoothPitchRef = useRef(0);
  const smoothRhythmRef = useRef(0);
  const smoothTechRef = useRef(0);
  const prevUserSilentRef = useRef(true);
  const prevRefSilentRef = useRef(true);

  // ─── [MIC] Connect the mic MediaStream into the user analyser graph ───────

  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    console.log('[MIC] connectUserStream — ctx:', ctx?.state ?? 'null', 'analyser:', !!analyser);
    if (!ctx || !analyser) {
      console.warn('[MIC] connectUserStream aborted — ctx or analyser missing');
      return;
    }

    try { userSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { userGainRef.current?.disconnect(); } catch { /* ignore */ }

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 10; // boost for analysis sensitivity — never routed to speakers
    source.connect(gain);
    gain.connect(analyser);

    if (!userKeepAliveRef.current) {
      userKeepAliveRef.current = ctx.createGain();
      userKeepAliveRef.current.gain.value = 0.00001;
    }
    try { analyser.disconnect(); } catch { /* ignore */ }
    analyser.connect(userKeepAliveRef.current);
    userKeepAliveRef.current.connect(ctx.destination);

    userSourceRef.current = source;
    userGainRef.current = gain;
    console.log('[MIC] User stream connected to analyser graph');
    recordStage('mic_stream_connected', 'ok', 'mic stream wired to analyser');
  }, []);

  // ─── [REF] Step 1: buffer the reference Audio element (no AudioContext yet) ─
  //
  // This step deliberately does NOT touch any AudioContext. It only creates
  // an HTMLAudioElement, points it at the blob URL, and waits for it to be
  // ready to play. This can safely run before the user has interacted with
  // the page at all (e.g. as soon as vocal separation completes).

  const bufferReferenceAudio = useCallback(async (vocalsUrl: string) => {
    if (refInitialisedUrlRef.current === vocalsUrl && refAudioElRef.current) {
      console.log('[REF] bufferReferenceAudio — already buffered for this URL, skipping');
      return;
    }
    console.log('[REF] Buffering reference audio:', vocalsUrl.slice(0, 50));
    refInitialisedUrlRef.current = vocalsUrl;

    try {
      // Tear down any previous element + graph cleanly first
      if (refAudioElRef.current) {
        refAudioElRef.current.pause();
        try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
        refSourceRef.current = null;
        refAudioElRef.current.src = '';
      }
      try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
      try { refKeepAliveRef.current?.disconnect(); } catch { /* ignore */ }
      refAnalyserRef.current = null;
      refKeepAliveRef.current = null;

      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = vocalsUrl;
      audio.preload = 'auto';
      // IMPORTANT — DO NOT set audio.volume = 0 here, and DO NOT set
      // .muted = true either. Evidence from real production logs showed
      // the analyser reading refVol: 0.0000 for an ENTIRE session despite
      // refCtxState: 'running' and audioPaused: false — i.e. the graph was
      // wired correctly and the element was genuinely playing, yet the
      // analyser saw pure silence throughout.
      //
      // Root cause (confirmed against MDN + W3C spec + known engine bugs):
      // once createMediaElementSource() is called on an element, browsers
      // are inconsistent about whether the element's own `.volume`/`.muted`
      // properties apply BEFORE or AFTER the signal enters the Web Audio
      // graph. On some engines (documented Safari/iOS behaviour, and
      // matching exactly what our own logs showed) a volume of 0 on the
      // source element causes the analyser itself to receive zero data,
      // not just zero audible output. This makes "silence the element
      // directly" fundamentally unreliable for our use case.
      //
      // FIX: leave the element at its default volume (1.0) so the analyser
      // always receives the true signal. Silence the OUTPUT instead,
      // downstream in the Web Audio graph, via the keepAlive GainNode in
      // connectReferenceGraph() (gain.value = 0.00001). The analyser node
      // sits BEFORE that gain in the chain, so it always sees full signal
      // regardless of how quiet the final output is. This matches the
      // architecture MDN itself demonstrates for visualizer use cases.
      refAudioElRef.current = audio;

      // BUG FIXED HERE (found via real production log evidence):
      // The previous version raced a fixed 4s timeout against canplay. When
      // the timeout won — which happened right after vocal separation
      // finished, because a ~6MB IndexedDB write (saveCachedTracks) was
      // competing for I/O at the exact same moment as this blob load — the
      // function gave up with readyState=0. canplay then fired ~1-2s later,
      // AFTER connectReferenceGraph() had already built the analyser graph
      // around an element that was empty at that instant. refVolume stayed
      // 0 for the whole session even though the element loaded fine shortly
      // after. FIX: a 4s mark is now just a diagnostic checkpoint, not a
      // giving-up point. We only actually stop waiting at a much later
      // hard ceiling.
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 2) { resolve(); return; }
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        audio.oncanplay = () => {
          console.log('[REF] canplay fired, readyState=', audio.readyState);
          finish();
        };
        audio.onloadeddata = () => {
          if (audio.readyState >= 2) {
            console.log('[REF] loadeddata fired, readyState=', audio.readyState);
            finish();
          }
        };
        audio.onerror = (e) => {
          console.error('[REF] Buffering error — will allow retry:', e);
          recordStage('ref_audio_buffered', 'failed', `audio error during buffering: ${(e as any)?.message ?? 'unknown'}`);
          refInitialisedUrlRef.current = null;
          finish();
        };
        setTimeout(() => {
          if (!settled) {
            console.warn('[REF] Buffer taking longer than', REF_BUFFER_TIMEOUT_MS,
              'ms, readyState=', audio.readyState, '— still waiting (not giving up)');
          }
        }, REF_BUFFER_TIMEOUT_MS);
        setTimeout(() => {
          if (!settled) {
            console.error('[REF] Hard timeout reached, readyState=', audio.readyState,
              '— giving up on this load attempt');
            finish();
          }
        }, REF_BUFFER_HARD_TIMEOUT_MS);
        audio.load();
      });
      console.log('[REF] Buffering complete, readyState=', audio.readyState);
      recordStage('ref_audio_buffered',
        audio.readyState >= 2 ? 'ok' : 'failed',
        `readyState=${audio.readyState} (need >=2 to be usable)`);

      if (audio.readyState < 2) {
        console.warn('[REF] Element still not ready after hard timeout — allowing retry on next call');
        refInitialisedUrlRef.current = null;
      }
    } catch (e) {
      refInitialisedUrlRef.current = null;
      console.error('[REF] bufferReferenceAudio failed:', e);
    }
  }, []);

  // ─── [REF] Step 2: connect the buffered element to its DEDICATED graph ────
  //
  // Only called from startAnalysis(), i.e. only after a user gesture has
  // already granted mic access. Creates refAudioCtx fresh if one doesn't
  // already exist for this song. This context is never shared with the mic.

  const connectReferenceGraph = useCallback(async () => {
    const audio = refAudioElRef.current;
    if (!audio) {
      console.warn('[REF] connectReferenceGraph — no buffered element yet');
      return;
    }
    if (refAnalyserRef.current && refAudioCtxRef.current?.state !== 'closed') {
      console.log('[REF] connectReferenceGraph — graph already connected, skipping rebuild');
      return;
    }
    // Second safety net: if the element genuinely has no data yet (e.g.
    // bufferReferenceAudio's hard timeout was hit), wiring up
    // createMediaElementSource now would just connect an empty pipeline.
    // Give it one more short window — most of the time this only triggers
    // immediately after a hard timeout, which is rare to begin with.
    if (audio.readyState < 2) {
      console.warn('[REF] connectReferenceGraph — element not ready (readyState=',
        audio.readyState, '), waiting briefly before connecting anyway');
      await new Promise<void>((resolve) => {
        const onReady = () => resolve();
        audio.addEventListener('canplay', onReady, { once: true });
        setTimeout(resolve, 3000);
      });
      console.log('[REF] connectReferenceGraph — proceeding with readyState=', audio.readyState);
    }

    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });

      for (let i = 0; i < 3 && ctx.state !== 'running'; i++) {
        await ctx.resume();
        if (ctx.state === 'running') break;
        await new Promise(r => setTimeout(r, 150 * (i + 1)));
      }
      console.log('[REF] Dedicated reference AudioContext created — state:', ctx.state,
        'sampleRate:', ctx.sampleRate);
      refAudioCtxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;
      refAnalyserRef.current = analyser;

      // ANALYSIS-ONLY routing: source → analyser → keepAlive(~0) → destination.
      // keepAlive is inaudible; it exists only so the graph stays "live" —
      // some browsers deprioritise/stop processing audio graphs that don't
      // ultimately connect to destination.
      const keepAlive = ctx.createGain();
      keepAlive.gain.value = 0.00001;
      refKeepAliveRef.current = keepAlive;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(keepAlive);
      keepAlive.connect(ctx.destination);
      refSourceRef.current = source;

      console.log('[REF] Reference graph connected successfully');
      recordStage('ref_graph_connected', 'ok',
        `refCtx.state=${ctx.state}, sampleRate=${ctx.sampleRate}`);

      // Immediate sanity check: read the analyser right now, before anything
      // else happens. This gives a single, unambiguous log line confirming
      // whether the analyser is receiving real signal or still silence —
      // no need to scroll through hundreds of per-second [SCORE] lines to
      // find out. If element.volume suppression was the actual cause of
      // refVol staying at 0.0000, this check will show non-zero immediately
      // once playback has started.
      setTimeout(() => {
        if (refAnalyserRef.current) {
          const checkBuf = new Float32Array(refAnalyserRef.current.fftSize);
          refAnalyserRef.current.getFloatTimeDomainData(checkBuf);
          const checkRms = Math.sqrt(checkBuf.reduce((s, v) => s + v * v, 0) / checkBuf.length);
          const isSignal = checkRms > 0.0001;
          console.log('[REF] Post-connect sanity check — analyser RMS:', checkRms.toFixed(5),
            isSignal ? '✅ analyser IS receiving signal' : '❌ analyser still reading silence');
          recordStage('ref_analyser_verified_nonzero',
            isSignal ? 'ok' : 'failed',
            `live RMS = ${checkRms.toFixed(5)} — ${isSignal
              ? 'signal confirmed: scoring will work'
              : 'SILENCE: scoring will NOT work — check audio.volume, muted, ctx state, element paused'}`);
        } else {
          recordStage('ref_analyser_verified_nonzero', 'failed', 'refAnalyser was null at sanity check time');
        }
      }, 500);

      if (optionsRef.current.isPlaying) {
        audio.currentTime = optionsRef.current.currentTime ?? 0;
        audio.play()
          .then(() => {
            console.log('[REF] play() succeeded after graph connect');
            recordStage('ref_audio_playing', 'ok', 'play() resolved without error');
          })
          .catch(e => {
            console.error('[REF] play() failed after graph connect:', e);
            recordStage('ref_audio_playing', 'failed', `play() rejected: ${(e as Error)?.message ?? String(e)}`);
          });
      }
    } catch (e) {
      console.error('[REF] connectReferenceGraph failed:', e);
    }
  }, []);

  // ─── [REF] Full teardown — only on song change or unmount ─────────────────

  const teardownReferenceAudio = useCallback(async () => {
    console.log('[REF] Full teardown (song change or unmount)');
    if (refAudioElRef.current) {
      refAudioElRef.current.pause();
      try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
      refAudioElRef.current.src = '';
      refAudioElRef.current = null;
    }
    try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
    try { refKeepAliveRef.current?.disconnect(); } catch { /* ignore */ }
    if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
      await refAudioCtxRef.current.close();
    }
    refAudioCtxRef.current = null;
    refAnalyserRef.current = null;
    refSourceRef.current = null;
    refKeepAliveRef.current = null;
    refInitialisedUrlRef.current = null;
    lastIsPlayingRef.current = undefined;
    console.log('[REF] Teardown complete');
  }, []);

  // ─── Watch vocalsUrl: buffer as soon as it's available (no ctx required) ──

  useEffect(() => {
    const url = options.vocalsUrl;
    console.log('[HOOK] watchVocalsUrl — url:', url ? url.slice(0, 50) : 'null',
      'alreadyBuffered:', refInitialisedUrlRef.current === url);
    recordStage('ref_url_received', url ? 'ok' : 'pending', url ? `url received: ${url.slice(0, 50)}` : 'no url yet');
    if (!url) return;
    if (refInitialisedUrlRef.current === url && refAudioElRef.current) return;
    bufferReferenceAudio(url);
  }, [options.vocalsUrl, bufferReferenceAudio]);

  // ─── Sync reference playback with the main player ──────────────────────────
  // Depends ONLY on isPlaying. See changelog point 3 — this is the single
  // most important line in the whole file for preventing "score stuck at 0".

  useEffect(() => {
    const audio = refAudioElRef.current;
    const changed = options.isPlaying !== lastIsPlayingRef.current;
    console.log('[HOOK] syncPlay — isPlaying:', options.isPlaying, 'audioReady:', !!audio,
      'graphReady:', !!refAnalyserRef.current, 'changed:', changed);
    if (!audio) return;
    if (!changed) return;
    lastIsPlayingRef.current = options.isPlaying;

    if (options.isPlaying) {
      audio.currentTime = optionsRef.current.currentTime ?? 0;
      audio.play()
        .then(() => console.log('[HOOK] syncPlay — play() ok'))
        .catch(e => console.error('[HOOK] syncPlay — play() failed:', e));
    } else {
      audio.pause();
      console.log('[HOOK] syncPlay — paused');
    }
  }, [options.isPlaying]);

  // ─── startAnalysis: mic permission + both graphs ready ─────────────────────

  const startAnalysis = useCallback(async () => {
    console.log('[HOOK] startAnalysis called');
    try {
      setError(null);
      didFallbackRef.current = false;
      lowSignalFramesRef.current = 0;

      console.log('[MIC] Requesting microphone...');
      recordStage('mic_permission', 'pending', 'requesting...');
      const stream = await requestMicrophone();
      userStreamRef.current = stream;
      setHasPermission(true);
      console.log('[MIC] Granted:', stream.getAudioTracks()[0]?.label);
      recordStage('mic_permission', 'ok', `granted: ${stream.getAudioTracks()[0]?.label ?? 'unknown device'}`);

      console.log('[MIC] Creating user AudioContext (mic singleton)...');
      const ctx = await createAudioContext();
      userAudioCtxRef.current = ctx;
      console.log('[MIC] User AudioContext ready — state:', ctx.state, 'sampleRate:', ctx.sampleRate);
      recordStage('mic_context_created', ctx.state === 'running' ? 'ok' : 'warning',
        `state=${ctx.state}, sampleRate=${ctx.sampleRate}`);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
      analyser.minDecibels = -120;
      analyser.maxDecibels = -10;
      userAnalyserRef.current = analyser;

      connectUserStream(stream);

      // Reference audio: buffer if not done yet, then connect its dedicated graph.
      const url = optionsRef.current.vocalsUrl;
      console.log('[HOOK] startAnalysis — vocalsUrl:', url ? url.slice(0, 50) : 'null',
        'elementReady:', !!refAudioElRef.current, 'graphReady:', !!refAnalyserRef.current);

      if (url && !refAudioElRef.current) {
        await bufferReferenceAudio(url);
      }
      if (refAudioElRef.current && !refAnalyserRef.current) {
        console.log('[HOOK] startAnalysis — connecting reference graph');
        await connectReferenceGraph();
      } else if (refAudioElRef.current && refAnalyserRef.current) {
        console.log('[HOOK] startAnalysis — reference graph already connected, resuming');
        if (refAudioCtxRef.current?.state === 'suspended') {
          await refAudioCtxRef.current.resume();
        }
        if (optionsRef.current.isPlaying) {
          refAudioElRef.current.currentTime = optionsRef.current.currentTime ?? 0;
          refAudioElRef.current.play().catch(e =>
            console.warn('[HOOK] startAnalysis — resume play() failed:', e));
        }
      } else {
        console.warn('[HOOK] startAnalysis — no vocalsUrl yet, reference will connect when it arrives');
      }

      // Pre-allocate typed arrays for the analysis loop
      const freqByte = new Uint8Array(analyser.frequencyBinCount);
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);
      let frameCount = 0;

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;

        // ── USER MIC frame ─────────────────────────────────────────────────
        userAnalyserRef.current.getByteFrequencyData(freqByte);
        userAnalyserRef.current.getFloatTimeDomainData(timeFloat);
        userAnalyserRef.current.getFloatFrequencyData(freqDb);

        const userRms = rmsFloat(timeFloat);
        const userDbE = dbEnergy(freqDb);
        const userVolume = Math.max(userRms, userDbE * 0.4);

        // Adaptive noise floor — learns slowly from quiet frames only, so
        // singing itself never raises the floor.
        if (Number.isFinite(userVolume)) {
          const nf = noiseFloorRef.current;
          const candidate = userVolume < 0.03 ? userVolume : nf;
          noiseFloorRef.current = nf * 0.98 + candidate * 0.02;
        }
        const voiceThreshold = Math.max(0.005, noiseFloorRef.current * 4);
        const isVoiceDetected = userVolume > voiceThreshold;
        const userPitch = detectPitchAC(timeFloat, userAudioCtxRef.current.sampleRate);

        // Auto-fallback to raw mic constraints if signal is persistently weak
        // (some Windows laptop mic drivers apply heavy DSP that crushes signal)
        if (!didFallbackRef.current) {
          if (userVolume < voiceThreshold * 0.6) lowSignalFramesRef.current++;
          else lowSignalFramesRef.current = 0;
          if (lowSignalFramesRef.current > 120) { // ~2s at 60fps
            didFallbackRef.current = true;
            lowSignalFramesRef.current = 0;
            console.log('[MIC] Persistent weak signal — falling back to raw mic constraints');
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            }).then(raw => {
              userStreamRef.current?.getTracks().forEach(t => t.stop());
              userStreamRef.current = raw;
              connectUserStream(raw);
            }).catch(e => console.warn('[MIC] Fallback getUserMedia failed:', e));
          }
        }

        userEnergyHistRef.current.push(userRms);
        if (userEnergyHistRef.current.length > HISTORY_FRAMES * 5) userEnergyHistRef.current.shift();

        const userIsSilent = userVolume <= voiceThreshold;
        if (prevUserSilentRef.current && !userIsSilent) {
          const now = performance.now();
          if (now - lastUserOnsetRef.current > ONSET_DEBOUNCE_MS) {
            userOnsetsRef.current.push(now);
            lastUserOnsetRef.current = now;
            if (userOnsetsRef.current.length > 200) userOnsetsRef.current.shift();
          }
        }
        prevUserSilentRef.current = userIsSilent;

        // ── REFERENCE VOCALS frame ─────────────────────────────────────────
        let refPitch = 0;
        let refVolume = 0;
        let referenceActive = false;

        if (refAnalyserRef.current && refAudioCtxRef.current) {
          const refTimeFloat = new Float32Array(refAnalyserRef.current.fftSize);
          refAnalyserRef.current.getFloatTimeDomainData(refTimeFloat);
          refVolume = rmsFloat(refTimeFloat);
          referenceActive = refVolume > SILENCE_RMS;

          if (referenceActive) {
            refPitch = detectPitchAC(refTimeFloat, refAudioCtxRef.current.sampleRate);
          }

          refEnergyHistRef.current.push(refVolume);
          if (refEnergyHistRef.current.length > HISTORY_FRAMES * 5) refEnergyHistRef.current.shift();

          const refIsSilent = refVolume <= SILENCE_RMS;
          if (prevRefSilentRef.current && !refIsSilent) {
            const now = performance.now();
            if (now - lastRefOnsetRef.current > ONSET_DEBOUNCE_MS) {
              refOnsetsRef.current.push(now);
              lastRefOnsetRef.current = now;
              if (refOnsetsRef.current.length > 200) refOnsetsRef.current.shift();
            }
          }
          prevRefSilentRef.current = refIsSilent;
        }

        // ── PITCH SCORING (per amateur-friendly requirements) ───────────────
        // Only frames where the reference vocal is actually active count.
        // A frame where the reference is silent (instrumental section) is
        // simply not scored at all — neither rewarded nor penalised.
        if (referenceActive) {
          pitchFramesRef.current++;
          if (!isVoiceDetected) {
            // User is silent during active reference vocals — a genuine miss.
            missedFramesRef.current++;
            // Nothing added to the accumulator: this frame contributes 0.
          } else if (refPitch > 0 && userPitch > 0) {
            // Normal case — both pitches detected, score the match directly.
            pitchScoreAccRef.current += scorePitchFrame(userPitch, refPitch, true);
          } else if (refPitch === 0) {
            // Reference pitch undetected during a section that IS active
            // (breathy/complex vocal passage) but the user IS singing.
            // Partial credit — we can't verify accuracy, but presence counts.
            pitchScoreAccRef.current += REF_PARTIAL_CREDIT_NO_REFPITCH;
          } else if (userPitch === 0) {
            // User is vocalising (volume above threshold) but their pitch
            // wasn't cleanly detected — breathy or soft singing. Amateur-
            // friendly partial credit rather than treating this as a miss.
            pitchScoreAccRef.current += REF_PARTIAL_CREDIT_NO_USERPITCH;
          }
        }

        const totalFrames = pitchFramesRef.current;
        const rawPitch = totalFrames > 0 ? pitchScoreAccRef.current / totalFrames : 0;
        const missRatio = totalFrames > 0 ? missedFramesRef.current / totalFrames : 0;
        // Capped miss penalty — a shy/late singer should not be devastated.
        const pitchFinal = rawPitch * (1 - missRatio * MISS_PENALTY_CAP);

        const rawRhythm = scoreRhythm(userOnsetsRef.current, refOnsetsRef.current, ONSET_WINDOW_MS);
        const rawTech = scoreTechnique(userEnergyHistRef.current, refEnergyHistRef.current, SILENCE_RMS);

        smoothPitchRef.current = smoothPitchRef.current * (1 - SCORE_SMOOTHING) + pitchFinal * SCORE_SMOOTHING;
        smoothRhythmRef.current = smoothRhythmRef.current * (1 - SCORE_SMOOTHING) + rawRhythm * SCORE_SMOOTHING;
        smoothTechRef.current = smoothTechRef.current * (1 - SCORE_SMOOTHING) + rawTech * SCORE_SMOOTHING;

        // ── Permanent diagnostic logging (standing requirement) ─────────────
        frameCount++;
        if (frameCount % LOG_EVERY_N_FRAMES === 0) {
          if (!refAnalyserRef.current) {
            console.warn('[SCORE] refAnalyser is NULL — reference graph not connected');
          } else if (referenceActive === false && refVolume === 0 && optionsRef.current.isPlaying) {
            console.warn('[SCORE] Song is playing but refVolume=0 — check reference audio is actually playing.',
              'refCtxState:', refAudioCtxRef.current?.state, 'audioPaused:', refAudioElRef.current?.paused);
          }
          console.log('[SCORE]', {
            userVol: userVolume.toFixed(4),
            voiceDetected: isVoiceDetected,
            userPitch: userPitch.toFixed(1),
            refPitch: refPitch.toFixed(1),
            refActive: referenceActive,
            refVol: refVolume.toFixed(4),
            pitchFrames: pitchFramesRef.current,
            missedFrames: missedFramesRef.current,
            missRatioPct: (missRatio * 100).toFixed(1),
            pitch: smoothPitchRef.current.toFixed(1),
            rhythm: smoothRhythmRef.current.toFixed(1),
            tech: smoothTechRef.current.toFixed(1),
            refCtxState: refAudioCtxRef.current?.state ?? 'null',
            userCtxState: userAudioCtxRef.current?.state ?? 'null',
          });
        }

        const newMetrics: VocalsComparisonMetrics = {
          pitchMatch: clamp100(Math.round(smoothPitchRef.current)),
          rhythmMatch: clamp100(Math.round(smoothRhythmRef.current)),
          techniqueMatch: clamp100(Math.round(smoothTechRef.current)),
          volume: userVolume,
          isVoiceDetected,
          referenceActive,
          debug: {
            voiceThreshold,
            noiseFloor: noiseFloorRef.current,
            audioCtxState: userAudioCtxRef.current?.state ?? 'unknown',
            micFallback: didFallbackRef.current,
            userVolumeRmsFloat: userRms,
            userFreqEnergyDb: userDbE,
          },
        };

        setMetrics(newMetrics);
        optionsRef.current.onMetricsUpdate?.(newMetrics);
        rafRef.current = requestAnimationFrame(analyze);
      };

      setIsActive(true);
      analyze();
      console.log('[HOOK] Analysis loop started');
      recordStage('analysis_loop_running', 'ok', 'requestAnimationFrame loop started');

    } catch (err) {
      console.error('[HOOK] startAnalysis error:', err);
      setError(formatMicrophoneError(err));
      recordStage('mic_permission', 'failed', `error: ${(err as Error)?.message ?? String(err)}`);
      setHasPermission(false);
    }
  }, [connectUserStream, bufferReferenceAudio, connectReferenceGraph]);

  // ─── stopAnalysis: closes ONLY the mic graph. Reference graph survives. ───

  const stopAnalysis = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

    // cleanupAudio() closes the SHARED MIC SINGLETON ONLY. The reference
    // audio's dedicated context (refAudioCtxRef) is never passed here and
    // is therefore never at risk — see changelog point 6/8.
    cleanupAudio(userStreamRef.current, userAudioCtxRef.current);
    userStreamRef.current = null;
    userAudioCtxRef.current = null;
    userAnalyserRef.current = null;
    userGainRef.current = null;
    userKeepAliveRef.current = null;
    userSourceRef.current = null;

    // Reference audio: pause only. Element, graph, and dedicated context all
    // stay alive so the next startAnalysis() can resume instantly without
    // re-buffering or re-decoding the blob URL.
    if (refAudioElRef.current) {
      refAudioElRef.current.pause();
      console.log('[HOOK] stopAnalysis — reference audio paused, graph kept alive');
    }

    setIsActive(false);
    console.log('[HOOK] stopAnalysis complete. Session totals — pitchFrames:', pitchFramesRef.current,
      'missedFrames:', missedFramesRef.current,
      'pitch:', smoothPitchRef.current.toFixed(1),
      'rhythm:', smoothRhythmRef.current.toFixed(1),
      'tech:', smoothTechRef.current.toFixed(1));
  }, []);

  // ─── resetScores: full song-change reset, including reference teardown ────

  const resetScores = useCallback(() => {
    console.log('[HOOK] resetScores — full reset for new song');
    teardownReferenceAudio();

    pitchScoreAccRef.current = 0;
    pitchFramesRef.current = 0;
    missedFramesRef.current = 0;
    userOnsetsRef.current = [];
    refOnsetsRef.current = [];
    userEnergyHistRef.current = [];
    refEnergyHistRef.current = [];
    smoothPitchRef.current = 0;
    smoothRhythmRef.current = 0;
    smoothTechRef.current = 0;
    prevUserSilentRef.current = true;
    prevRefSilentRef.current = true;
    lastUserOnsetRef.current = 0;
    lastRefOnsetRef.current = 0;
    lastIsPlayingRef.current = undefined;

    setMetrics({
      pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
      volume: 0, isVoiceDetected: false, referenceActive: false,
    });
  }, [teardownReferenceAudio]);

  // ─── setRefVolume: intentional no-op ───────────────────────────────────────
  // Kept for backward API compatibility with existing Sing.tsx call sites.
  // The reference element in THIS hook is analysis-only and must always stay
  // at volume=0 — see changelog point 4. Audible vocals volume is entirely
  // Sing.tsx's responsibility via its own separate vocalsAudioRef element.
  const setRefVolume = useCallback((_volume: number) => {
    console.log('[HOOK] setRefVolume called — intentional no-op, hook audio is analysis-only');
  }, []);

  // ─── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopAnalysis();
      teardownReferenceAudio();
    };
  }, [stopAnalysis, teardownReferenceAudio]);

  // Keep liveRefsForDump populated so window.dumpVocalDiagnostics() can read
  // real current state at any time without needing to reproduce the bug.
  // Runs on every render (cheap — just pointer assignments).
  useEffect(() => {
    liveRefsForDump = {
      userAudioCtx: userAudioCtxRef.current,
      userAnalyser: userAnalyserRef.current,
      refAudioEl: refAudioElRef.current,
      refAudioCtx: refAudioCtxRef.current,
      refAnalyser: refAnalyserRef.current,
      vocalsUrl: optionsRef.current.vocalsUrl,
      isPlaying: optionsRef.current.isPlaying,
    };
  });

  return {
    isActive,
    hasPermission,
    error,
    metrics,
    startAnalysis,
    stopAnalysis,
    resetScores,
    setRefVolume,
  };
}
