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
      // CRITICAL: volume=0, and volume=0 ONLY. Never .muted=true (blocks Web
      // Audio decode on Safari/Chrome — see changelog point 5). This element
      // must never be audible; Sing.tsx plays its own separate element for
      // what the user actually hears.
      audio.volume = 0;
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

      if (optionsRef.current.isPlaying) {
        audio.currentTime = optionsRef.current.currentTime ?? 0;
        audio.play()
          .then(() => console.log('[REF] play() succeeded after graph connect'))
          .catch(e => console.error('[REF] play() failed after graph connect:', e));
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
      const stream = await requestMicrophone();
      userStreamRef.current = stream;
      setHasPermission(true);
      console.log('[MIC] Granted:', stream.getAudioTracks()[0]?.label);

      console.log('[MIC] Creating user AudioContext (mic singleton)...');
      const ctx = await createAudioContext();
      userAudioCtxRef.current = ctx;
      console.log('[MIC] User AudioContext ready — state:', ctx.state, 'sampleRate:', ctx.sampleRate);

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

    } catch (err) {
      console.error('[HOOK] startAnalysis error:', err);
      setError(formatMicrophoneError(err));
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
