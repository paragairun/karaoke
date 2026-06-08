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
  // NEW: pass the already-playing Audio element from Sing.tsx directly.
  // This eliminates the race condition where the sync-play effect fires
  // before initRefAnalysis has finished creating the Audio element.
  vocalsAudioElement?: HTMLAudioElement | null;
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
  // We no longer create our own Audio element. Instead we tap into the one
  // Sing.tsx already manages. This eliminates the race condition entirely.
  const refAudioCtxRef = useRef<AudioContext | null>(null);
  const refAnalyserRef = useRef<AnalyserNode | null>(null);
  const refSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refKeepAliveRef = useRef<GainNode | null>(null);
  // Track which audio element we've connected to avoid double-connecting
  const connectedAudioElementRef = useRef<HTMLAudioElement | null>(null);

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

  // ─── Connect user mic stream ───────────────────────────────────────────────

  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    if (!ctx || !analyser) return;

    try { userSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { userGainRef.current?.disconnect(); } catch { /* ignore */ }

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 10;
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

  // ─── Connect reference audio element to analyser ──────────────────────────
  // THE FIX: Instead of creating a new Audio element and waiting for it to
  // load (which races against the play sync effect), we connect an AnalyserNode
  // to the Audio element that Sing.tsx ALREADY manages and is ALREADY playing.
  // No race condition. No second audio element. No duplicate blob decoding.

  const connectRefAudioElement = useCallback(async (audioEl: HTMLAudioElement) => {
    if (connectedAudioElementRef.current === audioEl) return; // already connected

    try {
      // Tear down previous ref context if any
      if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
        try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
        try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
        await refAudioCtxRef.current.close();
      }
      refAudioCtxRef.current = null;
      refAnalyserRef.current = null;
      refSourceRef.current = null;
      refKeepAliveRef.current = null;

      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') {
        for (let i = 0; i < 3; i++) {
          await ctx.resume();
          if (ctx.state === 'running') break;
          await new Promise(r => setTimeout(r, 150 * (i + 1)));
        }
      }
      refAudioCtxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;
      refAnalyserRef.current = analyser;

      // createMediaElementSource connects the existing element to Web Audio.
      // The element keeps playing normally — we just tap into its output.
      const source = ctx.createMediaElementSource(audioEl);
      source.connect(analyser);

      const keepAlive = ctx.createGain();
      keepAlive.gain.value = 0.00001;
      analyser.connect(keepAlive);
      keepAlive.connect(ctx.destination);
      refKeepAliveRef.current = keepAlive;
      refSourceRef.current = source;

      connectedAudioElementRef.current = audioEl;
      console.log('[vocals-comparison] Ref audio element connected to analyser');
    } catch (e) {
      console.error('[vocals-comparison] Failed to connect ref audio:', e);
    }
  }, []);

  // ─── Watch for vocalsAudioElement prop changes ─────────────────────────────
  // When Sing.tsx creates/updates its vocalsAudioRef, connect it to the analyser.
  // This effect runs whenever the audio element reference changes.
  useEffect(() => {
    const el = options.vocalsAudioElement;
    if (!el) return;
    if (el === connectedAudioElementRef.current) return;
    connectRefAudioElement(el);
  }, [options.vocalsAudioElement, connectRefAudioElement]);

  // ─── Fallback: init from URL if no element provided ──────────────────────
  // Kept for backwards compatibility. If vocalsAudioElement is not passed,
  // fall back to creating our own Audio element (original approach).
  // BUT: call audio.play() at the END if isPlaying is already true,
  // so we don't miss the play signal that fired while we were initialising.

  const initRefFromUrl = useCallback(async (vocalsUrl: string) => {
    if (connectedAudioElementRef.current) return; // already connected via element
    try {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = vocalsUrl;
      audio.volume = 0;
      audio.preload = 'auto';

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
      connectedAudioElementRef.current = audio;

      // FIX for URL fallback: if isPlaying was already true when we finished
      // initialising, start playback now — the sync effect fired too early.
      if (optionsRef.current.isPlaying) {
        audio.currentTime = optionsRef.current.currentTime ?? 0;
        audio.play().catch(() => {});
      }

      console.log('[vocals-comparison] Ref audio URL initialised');
    } catch (e) {
      console.error('[vocals-comparison] Failed to init ref from URL:', e);
    }
  }, []);

  // Re-init from URL if vocalsUrl arrives after startAnalysis (and no element)
  useEffect(() => {
    const url = optionsRef.current.vocalsUrl;
    const hasEl = !!options.vocalsAudioElement;
    if (isActive && url && !hasEl && !connectedAudioElementRef.current) {
      initRefFromUrl(url);
    }
  }, [isActive, options.vocalsUrl, options.vocalsAudioElement, initRefFromUrl]);

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

      // Connect ref audio — prefer the passed element, fall back to URL
      const el = optionsRef.current.vocalsAudioElement;
      const url = optionsRef.current.vocalsUrl;
      if (el) {
        await connectRefAudioElement(el);
      } else if (url) {
        await initRefFromUrl(url);
      }

      const freqByte = new Uint8Array(analyser.frequencyBinCount);
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);
      let frameCount = 0;

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;

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

        // ── Reference vocals readings ────────────────────────────────────
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
            pitchScoreAccRef.current += 40;
          } else if (isVoiceDetected && userPitch === 0) {
            pitchScoreAccRef.current += 25;
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
  }, [connectUserStream, connectRefAudioElement, initRefFromUrl]);

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

    // Disconnect ref analyser but do NOT close the audio element —
    // Sing.tsx owns it and will manage its lifecycle
    try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
    if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
      refAudioCtxRef.current.close().catch(() => {});
    }
    refAudioCtxRef.current = null;
    refAnalyserRef.current = null;
    refSourceRef.current = null;
    refKeepAliveRef.current = null;
    connectedAudioElementRef.current = null;

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
    setMetrics({
      pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
      volume: 0, isVoiceDetected: false, referenceActive: false,
    });
  }, []);

  useEffect(() => { return () => { stopAnalysis(); }; }, [stopAnalysis]);

  return { isActive, hasPermission, error, metrics, startAnalysis, stopAnalysis, resetScores };
}
