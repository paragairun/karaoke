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

export function useVocalsComparison(options: UseVocalsComparisonOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>({
    pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
    volume: 0, isVoiceDetected: false, referenceActive: false,
  });

  // ── FIX 1: Store options in a ref so callbacks are stable across renders.
  // The old version closed over `options` directly, which is a new object on
  // every render. This made startAnalysis/initRefAnalysis re-create on every
  // render (Bug 2) AND caused the currentTime useEffect to fire 60x/second
  // because options.currentTime is in its dep array (Bug 1 — the killer bug).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ── User mic refs ──────────────────────────────────────────────────────────
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

  // ── Reference vocals refs ──────────────────────────────────────────────────
  const refAudioCtxRef = useRef<AudioContext | null>(null);
  const refAnalyserRef = useRef<AnalyserNode | null>(null);
  const refSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refAudioRef = useRef<HTMLAudioElement | null>(null);
  const refKeepAliveRef = useRef<GainNode | null>(null);

  // ── Track last isPlaying to detect real play/pause transitions ────────────
  // FIX 1 (continued): only seek reference audio when isPlaying CHANGES,
  // not on every currentTime tick. The old dep array had both isPlaying AND
  // currentTime, so audio.currentTime was reset 60x/second, flushing the
  // decoded buffer and making the analyser always read silence →
  // referenceActive always false → score always 0.
  const lastIsPlayingRef = useRef<boolean | undefined>(undefined);

  // ── Scoring accumulators ───────────────────────────────────────────────────
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

  // ─── Connect user mic stream to analyser ──────────────────────────────────

  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    if (!ctx || !analyser) return;

    try { userSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { userGainRef.current?.disconnect(); } catch { /* ignore */ }

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 10; // analysis boost only — not audible
    source.connect(gain);
    gain.connect(analyser);

    // Keep-alive: required so some browsers actually process the graph
    if (!userKeepAliveRef.current) {
      userKeepAliveRef.current = ctx.createGain();
      userKeepAliveRef.current.gain.value = 0.00001;
    }
    try { analyser.disconnect(); } catch { /* ignore */ }
    analyser.connect(userKeepAliveRef.current);
    userKeepAliveRef.current.connect(ctx.destination);

    userSourceRef.current = source;
    userGainRef.current = gain;
  }, []); // stable — no options dependency

  // ─── Init reference vocals analysis ───────────────────────────────────────
  // FIX 2: Takes vocalsUrl as a parameter rather than closing over options.
  // This keeps the callback stable (empty dep array) while still reading
  // the latest URL at the moment it's called.

  const initRefAnalysis = useCallback(async (vocalsUrl: string) => {
    try {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = vocalsUrl;
      audio.volume = 0; // muted — analysis only
      audio.preload = 'auto';
      refAudioRef.current = audio;

      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') await ctx.resume();
      refAudioCtxRef.current = ctx;

      await new Promise<void>((resolve) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => resolve();
        setTimeout(resolve, 3000);
      });

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;
      refAnalyserRef.current = analyser;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);

      if (!refKeepAliveRef.current) {
        refKeepAliveRef.current = ctx.createGain();
        refKeepAliveRef.current.gain.value = 0.00001;
      }
      analyser.connect(refKeepAliveRef.current);
      refKeepAliveRef.current.connect(ctx.destination);
      refSourceRef.current = source;

      console.log('[vocals-comparison] Reference vocals initialised');
    } catch (e) {
      console.error('[vocals-comparison] Failed to init reference:', e);
    }
  }, []); // stable — vocalsUrl passed as param, not from closure

  // Re-init if vocalsUrl arrives after startAnalysis was already called
  useEffect(() => {
    const url = optionsRef.current.vocalsUrl;
    if (isActive && url && !refAudioRef.current) {
      initRefAnalysis(url);
    }
  }, [isActive, options.vocalsUrl, initRefAnalysis]);

  // ─── FIX 1: Sync reference audio — only on play/pause, NOT on every tick ──
  // OLD (broken): }, [options.isPlaying, options.currentTime])
  //   → fired 60x/second as currentTime updated via rAF
  //   → audio.currentTime reset every 16ms
  //   → decoded buffer flushed constantly
  //   → analyser always read near-silence
  //   → referenceActive always false → score always 0
  //
  // NEW (fixed): }, [options.isPlaying])
  //   → fires only when play/pause state changes
  //   → seeks once at play start, then ref audio runs freely in sync
  //   → analyser reads real audio data → referenceActive true → score works
  useEffect(() => {
    const audio = refAudioRef.current;
    if (!audio) return;

    const isPlaying = options.isPlaying;
    if (isPlaying === lastIsPlayingRef.current) return; // no real change
    lastIsPlayingRef.current = isPlaying;

    if (isPlaying) {
      audio.currentTime = optionsRef.current.currentTime ?? 0;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [options.isPlaying]); // ← isPlaying ONLY, never currentTime

  // ─── Main analysis loop ────────────────────────────────────────────────────

  const startAnalysis = useCallback(async () => {
    console.log('[vocals-comparison] startAnalysis called');
    try {
      setError(null);
      didFallbackRef.current = false;
      lowSignalFramesRef.current = 0;

      const stream = await requestMicrophone();
      userStreamRef.current = stream;
      setHasPermission(true);

      const ctx = await createAudioContext();
      userAudioCtxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
      analyser.minDecibels = -120;
      analyser.maxDecibels = -10;
      userAnalyserRef.current = analyser;

      connectUserStream(stream);

      // Read vocalsUrl from ref at call time — stable, no closure over options
      const vocalsUrl = optionsRef.current.vocalsUrl;
      if (vocalsUrl) await initRefAnalysis(vocalsUrl);

      const freqByte = new Uint8Array(analyser.frequencyBinCount);
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);
      let frameCount = 0;

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;

        // ── User mic readings ──────────────────────────────────────────────
        userAnalyserRef.current.getByteFrequencyData(freqByte);
        userAnalyserRef.current.getFloatTimeDomainData(timeFloat);
        userAnalyserRef.current.getFloatFrequencyData(freqDb);

        const userRms = rmsFloat(timeFloat);
        const userDbE = dbEnergy(freqDb);
        const userVolume = Math.max(userRms, userDbE * 0.4);

        // Adaptive noise floor (learns from quiet frames only)
        if (Number.isFinite(userVolume)) {
          const nf = noiseFloorRef.current;
          const candidate = userVolume < 0.03 ? userVolume : nf;
          noiseFloorRef.current = nf * 0.98 + candidate * 0.02;
        }
        const voiceThreshold = Math.max(0.005, noiseFloorRef.current * 4);
        const isVoiceDetected = userVolume > voiceThreshold;

        const userPitch = detectPitchAC(timeFloat, userAudioCtxRef.current.sampleRate);

        // Auto-fallback for Windows laptop mic paths with heavy DSP
        if (!didFallbackRef.current) {
          if (userVolume < voiceThreshold * 0.6) lowSignalFramesRef.current++;
          else lowSignalFramesRef.current = 0;
          if (lowSignalFramesRef.current > 120) {
            didFallbackRef.current = true;
            lowSignalFramesRef.current = 0;
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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

        // ── Reference vocals readings ──────────────────────────────────────
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
            // 0 added to acc by omission — missed frame scores 0
          } else if (refPitch > 0 && userPitch > 0) {
            pitchScoreAccRef.current += scorePitchFrame(userPitch, refPitch, true);
          } else if (isVoiceDetected && refPitch === 0) {
            // Ref vocal active but pitch undetected (breathy/complex section)
            // Award partial credit for singing during the right section
            pitchScoreAccRef.current += 40;
          } else if (isVoiceDetected && userPitch === 0) {
            // User voice detected but pitch undetected (breathy/soft singing)
            // Award partial credit — better than treating it as a miss
            pitchScoreAccRef.current += 25;
          }
        }

        // ── Rolling scores ─────────────────────────────────────────────────
        const totalFrames = pitchFramesRef.current;
        const rawPitch = totalFrames > 0 ? pitchScoreAccRef.current / totalFrames : 0;
        const missRatio = totalFrames > 0 ? missedFramesRef.current / totalFrames : 0;
        // Reduced miss penalty (0.3 not 0.5) — fairer for amateur singers
        const pitchFinal = rawPitch * (1 - missRatio * 0.3);

        const rawRhythm = scoreRhythm(userOnsetsRef.current, refOnsetsRef.current, ONSET_WINDOW_MS);
        const rawTech = scoreTechnique(userEnergyHistRef.current, refEnergyHistRef.current, SILENCE_RMS);

        smoothPitchRef.current = smoothPitchRef.current * (1 - SCORE_SMOOTHING) + pitchFinal * SCORE_SMOOTHING;
        smoothRhythmRef.current = smoothRhythmRef.current * (1 - SCORE_SMOOTHING) + rawRhythm * SCORE_SMOOTHING;
        smoothTechRef.current = smoothTechRef.current * (1 - SCORE_SMOOTHING) + rawTech * SCORE_SMOOTHING;

        frameCount++;
        if (frameCount % 60 === 0) {
          console.log('[vocals-comparison]', {
            userVol: userVolume.toFixed(4),
            voiceDetected: isVoiceDetected,
            userPitch: userPitch.toFixed(1),
            refPitch: refPitch.toFixed(1),
            refActive: referenceActive,
            refVol: refVolume.toFixed(4),
            missRatio: (missRatio * 100).toFixed(1) + '%',
            pitch: smoothPitchRef.current.toFixed(1),
            rhythm: smoothRhythmRef.current.toFixed(1),
            tech: smoothTechRef.current.toFixed(1),
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
      console.log('[vocals-comparison] Analysis started');

    } catch (err) {
      console.error('[vocals-comparison] Error:', err);
      setError(formatMicrophoneError(err));
      setHasPermission(false);
    }
  }, [connectUserStream, initRefAnalysis]); // stable — options via optionsRef

  // ─── Stop ──────────────────────────────────────────────────────────────────

  const stopAnalysis = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    cleanupAudio(userStreamRef.current, userAudioCtxRef.current);
    userStreamRef.current = null;
    userAudioCtxRef.current = null;
    userAnalyserRef.current = null;
    userGainRef.current = null;
    userKeepAliveRef.current = null;
    userSourceRef.current = null;
    if (refAudioRef.current) { refAudioRef.current.pause(); refAudioRef.current = null; }
    if (refAudioCtxRef.current) { refAudioCtxRef.current.close(); refAudioCtxRef.current = null; }
    refKeepAliveRef.current = null;
    lastIsPlayingRef.current = undefined;
    setIsActive(false);
    console.log('[vocals-comparison] Analysis stopped');
  }, []);

  // ─── Reset ─────────────────────────────────────────────────────────────────

  const resetScores = useCallback(() => {
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
  }, []);

  useEffect(() => { return () => { stopAnalysis(); }; }, [stopAnalysis]);

  return { isActive, hasPermission, error, metrics, startAnalysis, stopAnalysis, resetScores };
}
