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
// SCORING: all scoring rules, constants and the session accumulator live in
// src/lib/vocalScoring.ts (SessionScorer). This hook only measures each frame
// (your volume/pitch, reference activity/pitch) and feeds it to the scorer,
// so there is exactly one place that decides what a score is.
//
// v2 cleanup (scoring rebuild):
//   - Removed: per-frame EMA smoothing of running averages and Sing.tsx's
//     second 200ms accumulator on top of them (together they made the start
//     of a song count far more than the end).
//   - Removed: capped onset/energy/pitch history arrays, the unused user
//     energy history, the unused byte-spectrum read, the mic "fallback" that
//     re-requested identical constraints, and the setRefVolume no-op.
//   - Pitch detection now only runs when its result can be used.
//   - metrics state updates ~15x/s (was every frame, ~60x/s re-rendering
//     Sing.tsx); exact values are always available via getSessionSnapshot().
//
// v4 (reference melody): optional referencePitchUrl = pitch.json computed
//   once per song on Modal (CREPE). When loaded, the singer's pitch and
//   activity come from it at the song's currentTime; live detection on the
//   vocal stem (separation leftovers, backing vocals, harmonies) is only the
//   fallback for songs without one. The [SCORE] log shows refSource.
//
// v3 (scores while silent / vocals audible when muted):
//   - The hidden reference element is never played before it is captured
//     into the analysis graph. Sing.tsx starts the song before the mic is
//     ready; the old sync effect played the reference immediately, sending
//     the ORIGINAL vocals to the speakers at full volume (ignoring the vocals
//     slider) until capture — for the whole song if mic permission failed.
//   - Voice detection: noise floor is the 5th percentile of the last 10 s at
//     any level (NoiseFloorTracker); the old floor froze once auto-gain lifted
//     room noise above 0.03, so hum/fans scored (reproduced: total 785 while
//     silent). A frame also needs a clearly pitched sound (YIN clarity).
// =============================================================================

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  cleanupAudio,
  createAudioContext,
  formatMicrophoneError,
  requestMicrophone,
} from '@/lib/audioPermissions';
import {
  detectPitch,
  detectPitchAC,
  NoiseFloorTracker,
  parsePitchContour,
  contourPitchAt,
  type PitchContour,
  VOICE_MIN_CLARITY,
  rmsFloat,
  dbEnergy,
  SessionScorer,
  type SessionSnapshot,
  type RatingLetter,
} from '@/lib/vocalScoring';

// ─── Public types ───────────────────────────────────────────────────────────

export interface VocalsComparisonMetrics {
  // Session score (see vocalScoring.ts). Components are null until they have data.
  accuracy: number | null;   // 0-100
  flow: number | null;       // 0-100
  expression: number | null; // 0-100
  totalScore: number;        // 0-1000
  rating: RatingLetter;
  scoredFrames: number;      // frames that counted toward Accuracy
  // Live frame state
  scoringNow: boolean;       // this frame counted (window open, reference active, you singing)
  volume: number;            // your mic level (boosted x10 for analysis)
  isVoiceDetected: boolean;
  referenceActive: boolean;
  // Telemetry for score submission
  voicedFrames: number;
  refActiveFrames: number;
  noiseFloorSnapshot: number;
  debug?: {
    voiceThreshold: number;
    noiseFloor: number;
    audioCtxState: AudioContextState | 'unknown';
    userVolumeRmsFloat: number;
    userFreqEnergyDb: number;
  };
}

const EMPTY_METRICS: VocalsComparisonMetrics = {
  accuracy: null, flow: null, expression: null, totalScore: 0, rating: 'F', scoredFrames: 0,
  scoringNow: false, volume: 0, isVoiceDetected: false, referenceActive: false,
  voicedFrames: 0, refActiveFrames: 0, noiseFloorSnapshot: 0,
};

interface UseVocalsComparisonOptions {
  vocalsUrl?: string;
  currentTime?: number;
  isPlaying?: boolean;
  onMetricsUpdate?: (metrics: VocalsComparisonMetrics) => void;
  // Scoring window from Sing.tsx (lyrics started + inside a vocal section).
  // Frames are only scored when this is not false AND isPlaying is not false.
  // Detection keeps running either way. undefined = always open.
  scoringEnabled?: boolean;
  // Reference melody (pitch.json, computed once per song on Modal). When
  // loaded, the original singer's pitch and "is the singer singing" come from
  // it at the current song time (currentTime) instead of live detection on
  // the vocal stem. Songs without one keep live detection.
  referencePitchUrl?: string;
}

// ─── Tuning constants ──────────────────────────────────────────────────────

const FFT_SIZE = 2048;
const REF_VOCAL_THRESHOLD = 0.04;         // reference "active"; above SILENCE_RMS to ignore stem bleed
const REF_BUFFER_TIMEOUT_MS = 4000;       // soft checkpoint — logs a warning, does not give up
const REF_BUFFER_HARD_TIMEOUT_MS = 15000; // hard ceiling — actually gives up here
const METRICS_INTERVAL_MS = 66;           // ~15 UI updates per second
const LOG_INTERVAL_MS = 10000;            // one [SCORE] console snapshot every 10 s

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
  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>(EMPTY_METRICS);

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
  const noiseFloorRef = useRef(new NoiseFloorTracker()); // room noise, minimum statistics (vocalScoring.ts)

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

  // ── Session scoring: one scorer for the whole song (reset by resetAccumulators/resetScores)
  const scorerRef = useRef(new SessionScorer());
  const contourRef = useRef<PitchContour | null>(null);

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

    // FIXED: previously routed the user's OWN MIC INPUT through a
    // "keepAlive" gain at 0.00001 into destination (speakers) -- same
    // flawed pattern as the reference-vocals graph above, and carried a
    // secondary risk of a faint feedback loop (mic picking up its own
    // near-silent output from the speakers). Analyser data is read
    // directly via JS, it doesn't need a destination connection at all.
    // If a browser needs SOME active destination connection to keep this
    // context's processing from being deprioritized, a dedicated silent
    // oscillator (disconnected from any real signal) serves that purpose
    // without ever routing the user's actual voice back out.
    try { analyser.disconnect(); } catch { /* ignore */ }
    if (!userKeepAliveRef.current) {
      const keepAliveOsc = ctx.createOscillator();
      const keepAliveGain = ctx.createGain();
      keepAliveGain.gain.value = 0;
      keepAliveOsc.connect(keepAliveGain);
      keepAliveGain.connect(ctx.destination);
      keepAliveOsc.start();
      userKeepAliveRef.current = keepAliveGain;
    }

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

      // ANALYSIS-ONLY routing: source → analyser. The analyser does NOT
      // connect onward to destination at all -- its data is read directly
      // via getFloatTimeDomainData() in JS, it doesn't need a destination
      // connection to keep receiving audio.
      //
      // FIXED: this used to route the actual reference vocals signal
      // through a "keepAlive" gain node at 0.00001 (~-100dB) and INTO
      // destination (speakers) -- not truly silent, just very quiet, and
      // completely independent of Sing.tsx's own "Vocals On/Off" toggle
      // (which only controls a separate audio element). Human hearing
      // picks out vocal/speech content unusually well even at very low
      // volumes, so this was an audible leak regardless of the toggle
      // state. The dedicated keepAliveOsc below achieves the same
      // "keep this AudioContext active" goal some browsers need, using a
      // genuinely disconnected, silent oscillator that never carries any
      // real signal -- zero chance of any vocals content reaching
      // speakers at any gain, ever.
      const keepAliveOsc = ctx.createOscillator();
      const keepAliveGain = ctx.createGain();
      keepAliveGain.gain.value = 0;
      keepAliveOsc.connect(keepAliveGain);
      keepAliveGain.connect(ctx.destination);
      keepAliveOsc.start();
      refKeepAliveRef.current = keepAliveGain;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
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

  // ─── Reference melody: load once per song ──────────────────────────────────
  useEffect(() => {
    const url = options.referencePitchUrl;
    contourRef.current = null;
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(raw => {
        if (cancelled) return;
        const c = parsePitchContour(raw);
        contourRef.current = c;
        console.log(c
          ? `[REF] Reference melody loaded: ${c.cents.length} frames x ${c.hopMs} ms`
          : '[REF] Reference melody malformed — using live detection');
      })
      .catch(e => { if (!cancelled) console.warn('[REF] Reference melody unavailable — using live detection:', e); });
    return () => { cancelled = true; };
  }, [options.referencePitchUrl]);

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

    // The reference element plays at full volume (it must, see changelog
    // point 5) and is silent ONLY once createMediaElementSource() has
    // captured it into the analysis graph. Before that, playing it sends the
    // ORIGINAL VOCALS straight to the speakers, whatever the vocals slider
    // says (and the mic then hears them and scores them). Sing.tsx starts
    // the song before the mic/graph is ready, so this must wait:
    // connectReferenceGraph() starts it itself once captured.
    if (options.isPlaying && !refSourceRef.current) {
      audio.pause();
      // Unknown, so the next play/pause after capture is always applied.
      lastIsPlayingRef.current = undefined;
      console.log('[HOOK] syncPlay — reference not captured yet, held paused (would be audible)');
      return;
    }
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
      noiseFloorRef.current.reset(); // re-learn the room each time the mic starts

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

      // Pre-allocate buffers for the analysis loop.
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);
      let refTimeFloat: Float32Array<ArrayBuffer> | null = null;
      let lastMetricsAt = 0;
      let lastLogAt = performance.now();

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;
        const now = performance.now();

        // ── Your mic ────────────────────────────────────────────────────────
        userAnalyserRef.current.getFloatTimeDomainData(timeFloat);
        userAnalyserRef.current.getFloatFrequencyData(freqDb);
        const userRms = rmsFloat(timeFloat);
        const userDbE = dbEnergy(freqDb);
        const userVolume = Math.max(userRms, userDbE * 0.4);

        // Room noise floor (5th percentile of the last 10 s) and the level a
        // sound must exceed to be considered at all.
        noiseFloorRef.current.update(userVolume, now);
        const voiceThreshold = noiseFloorRef.current.voiceThreshold;
        const loudEnough = userVolume > voiceThreshold;

        // ── Reference vocals ────────────────────────────────────────────────
        let refVolume = 0;
        let referenceActive = false;
        const refAnalyser = refAnalyserRef.current;
        if (refAnalyser && refAudioCtxRef.current) {
          if (!refTimeFloat || refTimeFloat.length !== refAnalyser.fftSize) {
            refTimeFloat = new Float32Array(refAnalyser.fftSize);
          }
          refAnalyser.getFloatTimeDomainData(refTimeFloat);
          refVolume = rmsFloat(refTimeFloat);
          referenceActive = refVolume > REF_VOCAL_THRESHOLD;
        }
        // Reference melody, when loaded, replaces live detection for both
        // "is the singer singing" and the singer's pitch.
        const contour = contourRef.current;
        const contourHz = contour ? contourPitchAt(contour, optionsRef.current.currentTime ?? 0) : 0;
        if (contour) referenceActive = contourHz > 0;

        // ── Score this frame ────────────────────────────────────────────────
        // You count as singing only if loud enough AND clearly pitched: room
        // noise, typing and clicks are aperiodic and fail the clarity test.
        // Pitch detection is the expensive step, so it only runs when the
        // result can be used.
        const scoringOpen = optionsRef.current.scoringEnabled !== false && optionsRef.current.isPlaying !== false;
        let userPitch = 0;
        let userClarity = 0;
        if (scoringOpen && referenceActive && loudEnough) {
          const p = detectPitch(timeFloat, userAudioCtxRef.current.sampleRate);
          userClarity = p.clarity;
          if (p.hz > 0 && p.clarity >= VOICE_MIN_CLARITY) userPitch = p.hz;
        }
        const isVoiceDetected = loudEnough && (userPitch > 0 || !(scoringOpen && referenceActive));
        const scoringNow = scoringOpen && referenceActive && userPitch > 0;
        const refPitch = !scoringNow ? 0
          : contour ? contourHz
          : refTimeFloat && refAudioCtxRef.current ? detectPitchAC(refTimeFloat, refAudioCtxRef.current.sampleRate) : 0;
        scorerRef.current.frame({
          t: now, scoringOpen, refActive: referenceActive, refPitch,
          userVoiced: scoringNow, userPitch,
        });

        // ── Diagnostics (standing requirement: one snapshot every 10 s) ─────
        if (now - lastLogAt >= LOG_INTERVAL_MS) {
          lastLogAt = now;
          if (!refAnalyser) console.warn('[SCORE] reference analyser not connected');
          const snap = scorerRef.current.snapshot();
          console.log('[SCORE]', {
            userVol: userVolume.toFixed(4), noiseFloor: noiseFloorRef.current.floor.toFixed(4),
            voiceThreshold: voiceThreshold.toFixed(4), loudEnough, userClarity: userClarity.toFixed(2),
            voiceDetected: isVoiceDetected,
            refSource: contour ? 'melody' : 'live', refVol: refVolume.toFixed(4), refActive: referenceActive, scoringOpen,
            userPitch: userPitch.toFixed(1), refPitch: refPitch.toFixed(1),
            accuracy: snap.accuracy?.toFixed(1) ?? '-', flow: snap.flow?.toFixed(1) ?? '-',
            expression: snap.expression?.toFixed(1) ?? '-', total: snap.total,
            scoredFrames: snap.scoredFrames,
            completionPct: snap.completion !== null ? (snap.completion * 100).toFixed(1) : '-',
            refCtxState: refAudioCtxRef.current?.state ?? 'null',
            userCtxState: userAudioCtxRef.current?.state ?? 'null',
          });
        }

        // ── Publish (~15x/s; exact values via getSessionSnapshot) ───────────
        if (now - lastMetricsAt >= METRICS_INTERVAL_MS) {
          lastMetricsAt = now;
          const snap = scorerRef.current.snapshot();
          const newMetrics: VocalsComparisonMetrics = {
            accuracy: snap.accuracy, flow: snap.flow, expression: snap.expression,
            totalScore: snap.total, rating: snap.rating, scoredFrames: snap.scoredFrames,
            scoringNow, volume: userVolume, isVoiceDetected, referenceActive,
            voicedFrames: snap.voicedFrames, refActiveFrames: snap.refActiveFrames,
            noiseFloorSnapshot: noiseFloorRef.current.floor,
            debug: {
              voiceThreshold,
              noiseFloor: noiseFloorRef.current.floor,
              audioCtxState: userAudioCtxRef.current?.state ?? 'unknown',
              userVolumeRmsFloat: userRms,
              userFreqEnergyDb: userDbE,
            },
          };
          setMetrics(newMetrics);
          optionsRef.current.onMetricsUpdate?.(newMetrics);
        }

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
    const snap = scorerRef.current.snapshot();
    console.log('[HOOK] stopAnalysis complete. Session —',
      'scoredFrames:', snap.scoredFrames,
      'voicedFrames:', snap.voicedFrames,
      'refActiveFrames:', snap.refActiveFrames,
      'completion:', snap.completion !== null ? (snap.completion * 100).toFixed(1) + '%' : 'n/a',
      'accuracy:', snap.accuracy?.toFixed(1) ?? '-',
      'flow:', snap.flow?.toFixed(1) ?? '-',
      'expression:', snap.expression?.toFixed(1) ?? '-',
      'total:', snap.total);
  }, []);

  // ─── resetScores: full song-change reset, including reference teardown ────

  const resetAccumulators = useCallback(() => {
    scorerRef.current.reset();
    setMetrics(EMPTY_METRICS);
  }, []);

  // Exact session values right now (metrics state is throttled to ~15x/s).
  const getSessionSnapshot = useCallback((): SessionSnapshot => scorerRef.current.snapshot(), []);

  // Score any reference phrase starts still inside their matching window
  // (call once when the song ends, before reading the final snapshot).
  const finalizeSession = useCallback((): SessionSnapshot => {
    scorerRef.current.finalize(performance.now());
    const snap = scorerRef.current.snapshot();
    setMetrics(m => ({
      ...m, accuracy: snap.accuracy, flow: snap.flow, expression: snap.expression,
      totalScore: snap.total, rating: snap.rating, scoredFrames: snap.scoredFrames,
      voicedFrames: snap.voicedFrames, refActiveFrames: snap.refActiveFrames,
    }));
    return snap;
  }, []);

  const resetScores = useCallback(() => {
    teardownReferenceAudio();
    resetAccumulators();
    lastIsPlayingRef.current = undefined;
  }, [teardownReferenceAudio, resetAccumulators]);

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
    resetAccumulators,
    getSessionSnapshot,
    finalizeSession,
  };
}
