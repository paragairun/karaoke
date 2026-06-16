// =============================================================================
// CHANGELOG
// =============================================================================
// v1–v7 — see git history
//
// v8 — Fixed audio player broken by premature AudioContext creation
//   - initRefFromUrl was creating AudioContext before startAnalysis ran
//   - Premature AudioContext captured HTMLAudioElement output on iOS/Chrome
//   - Fix: initRefFromUrl only creates Audio element, defers graph connection
//
// v9 — CURRENT: Permanent fix — two completely separate AudioContexts
//   - ROOT CAUSE of all audio player breakage:
//     ref audio graph was connected to the singleton (user mic) AudioContext.
//     stopAnalysis called cleanupAudio() which closes the singleton when
//     refCount hits 0. The ref audio element remained connected to the now-
//     closed context. On next play: broken graph, silence, broken player.
//   - PERMANENT FIX:
//     Two separate AudioContexts with separate lifecycles:
//     1. userAudioCtx — for mic analysis only. Opened in startAnalysis,
//        closed in stopAnalysis via cleanupAudio(). Short lifecycle.
//     2. refAudioCtx — for ref vocals analysis only. Created in
//        connectRefAudioGraph(), NEVER closed in stopAnalysis.
//        Only torn down in resetScores() when the song changes.
//     These two contexts never share nodes. They cannot interfere.
//   - Diagnostic logs kept throughout for ongoing debugging
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VocalsComparisonMetrics {
  pitchMatch: number;
  rhythmMatch: number;
  techniqueMatch: number;
  volume: number;
  isVoiceDetected: boolean;
  referenceActive: boolean;
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

const FFT_SIZE = 2048;
const HISTORY_FRAMES = 60;
const SCORE_SMOOTHING = 0.12;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVocalsComparison(options: UseVocalsComparisonOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>({
    pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
    volume: 0, isVoiceDetected: false, referenceActive: false,
  });

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ── USER MIC refs (short lifecycle: open in startAnalysis, close in stopAnalysis)
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

  // ── REF AUDIO refs (long lifecycle: survive stop/start, only reset on song change)
  // These use a DEDICATED AudioContext that is NEVER shared with the mic.
  // This prevents stopAnalysis from accidentally closing the ref audio graph.
  const refAudioCtxRef = useRef<AudioContext | null>(null);   // dedicated, never closed in stopAnalysis
  const refAnalyserRef = useRef<AnalyserNode | null>(null);
  const refSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refKeepAliveRef = useRef<GainNode | null>(null);
  const refAudioElRef = useRef<HTMLAudioElement | null>(null);
  const refInitialisedUrlRef = useRef<string | null>(null);   // prevents double-init

  // Track isPlaying changes (avoid 60fps seek loop)
  const lastIsPlayingRef = useRef<boolean | undefined>(undefined);

  // ── Scoring accumulators (reset in resetScores)
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

  // ─── Connect user mic stream ───────────────────────────────────────────────

  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    console.log('[MIC] connectUserStream: ctx=', ctx?.state ?? 'null', 'analyser=', !!analyser);
    if (!ctx || !analyser) {
      console.warn('[MIC] connectUserStream: missing ctx or analyser — not connected');
      return;
    }
    try { userSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { userGainRef.current?.disconnect(); } catch { /* ignore */ }

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 10; // boost for analysis — not audible
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
  }, []);

  // ─── Build ref audio Web Audio graph ──────────────────────────────────────
  // Uses a DEDICATED AudioContext (refAudioCtxRef) that is completely separate
  // from the user mic context. This context is NEVER closed by stopAnalysis.
  // Only torn down in teardownRefAudio() called from resetScores() on song change.

  const connectRefAudioGraph = useCallback(async (audio: HTMLAudioElement) => {
    try {
      // Close previous ref ctx cleanly if it exists
      if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
        try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
        try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
        try { refKeepAliveRef.current?.disconnect(); } catch { /* ignore */ }
        await refAudioCtxRef.current.close();
        console.log('[REF-AUDIO] Previous ref ctx closed for reconnect');
      }
      refAnalyserRef.current = null;
      refSourceRef.current = null;
      refKeepAliveRef.current = null;
      refAudioCtxRef.current = null;

      // Create a DEDICATED AudioContext for ref audio analysis.
      // This context is intentionally separate from the user mic singleton.
      // It will NOT be closed when stopAnalysis runs.
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });

      // Resume with retries (iOS may start suspended)
      for (let i = 0; i < 3; i++) {
        if (ctx.state === 'running') break;
        await ctx.resume();
        if (ctx.state === 'running') break;
        await new Promise(r => setTimeout(r, 150 * (i + 1)));
      }
      console.log('[REF-AUDIO] Dedicated ref ctx created: state=', ctx.state, 'sampleRate=', ctx.sampleRate);
      refAudioCtxRef.current = ctx;

      // ANALYSIS-ONLY routing: source → analyser → keepAlive(~0) → destination
      // audio.volume=0 ensures nothing audible reaches speakers from this path.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;
      refAnalyserRef.current = analyser;

      const keepAlive = ctx.createGain();
      keepAlive.gain.value = 0.00001; // inaudible keepalive
      refKeepAliveRef.current = keepAlive;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(keepAlive);
      keepAlive.connect(ctx.destination);
      refSourceRef.current = source;

      console.log('[REF-AUDIO] Graph connected successfully');

      // Start playing if we should be
      if (optionsRef.current.isPlaying) {
        audio.currentTime = optionsRef.current.currentTime ?? 0;
        audio.play()
          .then(() => console.log('[REF-AUDIO] play() succeeded after graph connect'))
          .catch(e => console.error('[REF-AUDIO] play() failed after graph connect:', e));
      }
    } catch (e) {
      console.error('[REF-AUDIO] connectRefAudioGraph failed:', e);
    }
  }, []);

  // ─── Init ref audio from URL ───────────────────────────────────────────────
  // Creates the Audio element and buffers it.
  // Does NOT create an AudioContext — that is done in connectRefAudioGraph()
  // which is called only from startAnalysis (after user gesture).
  // This prevents premature AudioContext creation from interfering with
  // the main instrumental player.

  const initRefFromUrl = useCallback(async (vocalsUrl: string) => {
    if (refInitialisedUrlRef.current === vocalsUrl) {
      console.log('[REF-AUDIO] Already initialised for this URL, skipping');
      return;
    }
    refInitialisedUrlRef.current = vocalsUrl;
    console.log('[REF-AUDIO] Initialising ref audio for:', vocalsUrl.slice(0, 40));

    try {
      // Tear down previous audio element only (NOT the AudioContext graph)
      if (refAudioElRef.current) {
        refAudioElRef.current.pause();
        // Disconnect source before clearing src — prevents decode pipeline error
        try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
        refSourceRef.current = null;
        refAudioElRef.current.src = '';
        refAudioElRef.current = null;
      }
      // Reset analyser refs since source is gone
      try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
      try { refKeepAliveRef.current?.disconnect(); } catch { /* ignore */ }
      refAnalyserRef.current = null;
      refKeepAliveRef.current = null;

      // Create audio element.
      // volume=0: analysis only — must never play through speakers.
      // Do NOT set muted=true: blocks Web Audio decoding on Safari/Chrome.
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = vocalsUrl;
      audio.preload = 'auto';
      audio.volume = 0;
      refAudioElRef.current = audio;
      console.log('[REF-AUDIO] Audio element created, waiting for buffer...');

      // Buffer the audio (no AudioContext involved yet)
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 2) { resolve(); return; }
        audio.oncanplay = () => {
          console.log('[REF-AUDIO] canplay fired, readyState=', audio.readyState);
          resolve();
        };
        audio.onerror = (e) => {
          console.error('[REF-AUDIO] audio error during buffering:', e);
          refInitialisedUrlRef.current = null; // allow retry
          resolve();
        };
        setTimeout(() => {
          console.warn('[REF-AUDIO] Buffer timeout, readyState=', audio.readyState);
          resolve();
        }, 4000);
        audio.load();
      });
      console.log('[REF-AUDIO] Audio buffered, readyState=', audio.readyState);

      // If startAnalysis has already run, connect the graph now.
      // Otherwise startAnalysis will call connectRefAudioGraph when it runs.
      // NOTE: we check refAudioCtxRef, NOT userAudioCtxRef.
      // We always create a dedicated ctx for ref audio.
      if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
        console.log('[REF-AUDIO] Ref ctx already exists, reconnecting graph');
        await connectRefAudioGraph(audio);
      } else {
        console.log('[REF-AUDIO] No ref ctx yet — graph connection deferred to startAnalysis');
      }
    } catch (e) {
      refInitialisedUrlRef.current = null;
      console.error('[REF-AUDIO] initRefFromUrl failed:', e);
    }
  }, [connectRefAudioGraph]);

  // ─── Tear down ref audio completely (song change) ──────────────────────────

  const teardownRefAudio = useCallback(async () => {
    console.log('[REF-AUDIO] Tearing down ref audio (song change)');
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
    console.log('[REF-AUDIO] Teardown complete');
  }, []);

  // ─── Watch vocalsUrl changes ───────────────────────────────────────────────

  useEffect(() => {
    const url = options.vocalsUrl;
    console.log('[HOOK] watchVocalsUrl: url=', url ? url.slice(0, 40) : 'null',
      'alreadyInit=', refInitialisedUrlRef.current === url);
    if (!url) return;
    if (refInitialisedUrlRef.current === url) return;
    initRefFromUrl(url);
  }, [options.vocalsUrl, initRefFromUrl]);

  // ─── Sync ref audio play/pause with main player ───────────────────────────
  // Fires only on isPlaying transitions — NOT on every currentTime tick.

  useEffect(() => {
    const audio = refAudioElRef.current;
    console.log('[HOOK] syncPlay: isPlaying=', options.isPlaying,
      'audioExists=', !!audio, 'graphOk=', !!refAnalyserRef.current,
      'changed=', options.isPlaying !== lastIsPlayingRef.current);
    if (!audio) return;
    if (options.isPlaying === lastIsPlayingRef.current) return;
    lastIsPlayingRef.current = options.isPlaying;

    if (options.isPlaying) {
      audio.currentTime = optionsRef.current.currentTime ?? 0;
      audio.play()
        .then(() => console.log('[HOOK] syncPlay: play() ok'))
        .catch(e => console.error('[HOOK] syncPlay: play() failed:', e));
    } else {
      audio.pause();
      console.log('[HOOK] syncPlay: paused');
    }
  }, [options.isPlaying]);

  // ─── Main analysis loop ────────────────────────────────────────────────────

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

      console.log('[MIC] Creating AudioContext (user mic singleton)...');
      const ctx = await createAudioContext();
      userAudioCtxRef.current = ctx;
      console.log('[MIC] AudioContext ready: state=', ctx.state, 'sampleRate=', ctx.sampleRate);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
      analyser.minDecibels = -120;
      analyser.maxDecibels = -10;
      userAnalyserRef.current = analyser;

      connectUserStream(stream);

      // Connect ref audio graph using its DEDICATED context (not the mic singleton).
      // This runs regardless of whether initRefFromUrl has completed or not.
      const url = optionsRef.current.vocalsUrl;
      console.log('[HOOK] startAnalysis: vocalsUrl=', url ? url.slice(0, 40) : 'null',
        'refElExists=', !!refAudioElRef.current,
        'refAnalyserOk=', !!refAnalyserRef.current);

      if (url && !refInitialisedUrlRef.current) {
        // vocalsUrl not yet buffered — buffer it now
        await initRefFromUrl(url);
      }

      if (refAudioElRef.current && !refAnalyserRef.current) {
        // Element buffered but graph not connected yet — connect now
        console.log('[HOOK] startAnalysis: connecting ref audio graph');
        await connectRefAudioGraph(refAudioElRef.current);
      } else if (refAudioElRef.current && refAnalyserRef.current) {
        // Graph already connected from previous session — just play
        console.log('[HOOK] startAnalysis: ref graph already connected, resuming');
        // Resume the dedicated ctx if suspended
        if (refAudioCtxRef.current && refAudioCtxRef.current.state === 'suspended') {
          await refAudioCtxRef.current.resume();
          console.log('[HOOK] startAnalysis: ref ctx resumed');
        }
        if (optionsRef.current.isPlaying && refAudioElRef.current) {
          refAudioElRef.current.currentTime = optionsRef.current.currentTime ?? 0;
          refAudioElRef.current.play()
            .then(() => console.log('[HOOK] startAnalysis: ref play() ok'))
            .catch(e => console.warn('[HOOK] startAnalysis: ref play() failed:', e));
        }
      } else {
        console.warn('[HOOK] startAnalysis: no ref audio yet — will connect when URL arrives');
      }

      // Pre-allocate typed arrays for the rAF loop
      const freqByte = new Uint8Array(analyser.frequencyBinCount);
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);
      let frameCount = 0;

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;

        // ── User mic ──────────────────────────────────────────────────────
        userAnalyserRef.current.getByteFrequencyData(freqByte);
        userAnalyserRef.current.getFloatTimeDomainData(timeFloat);
        userAnalyserRef.current.getFloatFrequencyData(freqDb);

        const userRms = rmsFloat(timeFloat);
        const userDbE = dbEnergy(freqDb);
        const userVolume = Math.max(userRms, userDbE * 0.4);

        if (Number.isFinite(userVolume)) {
          const nf = noiseFloorRef.current;
          const candidate = userVolume < 0.03 ? userVolume : nf;
          noiseFloorRef.current = nf * 0.98 + candidate * 0.02;
        }
        const voiceThreshold = Math.max(0.005, noiseFloorRef.current * 4);
        const isVoiceDetected = userVolume > voiceThreshold;
        const userPitch = detectPitchAC(timeFloat, userAudioCtxRef.current.sampleRate);

        // Auto-fallback for persistently quiet mic paths (Windows DSP)
        if (!didFallbackRef.current) {
          if (userVolume < voiceThreshold * 0.6) lowSignalFramesRef.current++;
          else lowSignalFramesRef.current = 0;
          if (lowSignalFramesRef.current > 120) {
            didFallbackRef.current = true;
            lowSignalFramesRef.current = 0;
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            }).then(raw => {
              userStreamRef.current?.getTracks().forEach(t => t.stop());
              userStreamRef.current = raw;
              connectUserStream(raw);
            }).catch(() => {});
          }
        }

        userEnergyHistRef.current.push(userRms);
        if (userEnergyHistRef.current.length > HISTORY_FRAMES * 5) userEnergyHistRef.current.shift();

        const userIsSilent = userVolume <= voiceThreshold;
        if (prevUserSilentRef.current && !userIsSilent) {
          const now = performance.now();
          if (now - lastUserOnsetRef.current > 100) {
            userOnsetsRef.current.push(now);
            lastUserOnsetRef.current = now;
            if (userOnsetsRef.current.length > 200) userOnsetsRef.current.shift();
          }
        }
        prevUserSilentRef.current = userIsSilent;

        // ── Reference vocals ──────────────────────────────────────────────
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
            if (now - lastRefOnsetRef.current > 100) {
              refOnsetsRef.current.push(now);
              lastRefOnsetRef.current = now;
              if (refOnsetsRef.current.length > 200) refOnsetsRef.current.shift();
            }
          }
          prevRefSilentRef.current = refIsSilent;
        }

        // ── Per-frame pitch scoring ────────────────────────────────────────
        if (referenceActive) {
          pitchFramesRef.current++;
          if (!isVoiceDetected) {
            missedFramesRef.current++;
          } else if (refPitch > 0 && userPitch > 0) {
            pitchScoreAccRef.current += scorePitchFrame(userPitch, refPitch, true);
          } else if (isVoiceDetected && refPitch === 0) {
            pitchScoreAccRef.current += 40; // partial: singing during vocal section
          } else if (isVoiceDetected && userPitch === 0) {
            pitchScoreAccRef.current += 25; // partial: breathy singing
          }
        }

        const totalFrames = pitchFramesRef.current;
        const rawPitch = totalFrames > 0 ? pitchScoreAccRef.current / totalFrames : 0;
        const missRatio = totalFrames > 0 ? missedFramesRef.current / totalFrames : 0;
        const pitchFinal = rawPitch * (1 - missRatio * 0.3);
        const rawRhythm = scoreRhythm(userOnsetsRef.current, refOnsetsRef.current, ONSET_WINDOW_MS);
        const rawTech = scoreTechnique(userEnergyHistRef.current, refEnergyHistRef.current, SILENCE_RMS);

        smoothPitchRef.current = smoothPitchRef.current * (1 - SCORE_SMOOTHING) + pitchFinal * SCORE_SMOOTHING;
        smoothRhythmRef.current = smoothRhythmRef.current * (1 - SCORE_SMOOTHING) + rawRhythm * SCORE_SMOOTHING;
        smoothTechRef.current = smoothTechRef.current * (1 - SCORE_SMOOTHING) + rawTech * SCORE_SMOOTHING;

        // Log every ~1s
        frameCount++;
        if (frameCount % 60 === 0) {
          if (!refAnalyserRef.current) {
            console.warn('[SCORE] WARNING: refAnalyser is null — ref audio not connected');
          } else if (refVolume === 0) {
            console.warn('[SCORE] WARNING: refAnalyser exists but refVolume=0 — audio not playing?',
              'refCtxState=', refAudioCtxRef.current?.state,
              'audioEl=', !!refAudioElRef.current);
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
      console.log('[HOOK] Analysis started');

    } catch (err) {
      console.error('[HOOK] startAnalysis error:', err);
      setError(formatMicrophoneError(err));
      setHasPermission(false);
    }
  }, [connectUserStream, connectRefAudioGraph, initRefFromUrl]);

  // ─── Stop analysis (closes user mic context ONLY, ref audio graph stays alive)

  const stopAnalysis = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

    // Stop mic and close the user mic AudioContext (singleton).
    // The ref audio graph (refAudioCtxRef, refAnalyserRef, etc.) is intentionally
    // kept alive so startAnalysis can resume without re-initialising the blob URL.
    cleanupAudio(userStreamRef.current, userAudioCtxRef.current);
    userStreamRef.current = null;
    userAudioCtxRef.current = null;
    userAnalyserRef.current = null;
    userGainRef.current = null;
    userKeepAliveRef.current = null;
    userSourceRef.current = null;

    // Pause ref audio but keep graph intact
    if (refAudioElRef.current) {
      refAudioElRef.current.pause();
      console.log('[HOOK] stopAnalysis: ref audio paused, graph kept alive');
    }

    setIsActive(false);
    console.log('[HOOK] stopAnalysis done. Final: pitchFrames=', pitchFramesRef.current,
      'pitch=', smoothPitchRef.current.toFixed(1),
      'rhythm=', smoothRhythmRef.current.toFixed(1),
      'tech=', smoothTechRef.current.toFixed(1));
  }, []);

  // ─── Reset scores (song change — full teardown of ref audio) ──────────────

  const resetScores = useCallback(() => {
    console.log('[HOOK] resetScores called — tearing down ref audio');
    teardownRefAudio();

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
  }, [teardownRefAudio]);

  // ─── no-op: audible vocals volume controlled by Sing.tsx vocalsAudioRef ───
  const setRefVolume = useCallback((_volume: number) => { /* no-op */ }, []);

  // ─── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopAnalysis();
      teardownRefAudio();
    };
  }, [stopAnalysis, teardownRefAudio]);

  return { isActive, hasPermission, error, metrics, startAnalysis, stopAnalysis, resetScores, setRefVolume };
}
