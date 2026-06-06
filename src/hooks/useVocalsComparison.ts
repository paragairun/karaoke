import { useState, useRef, useCallback, useEffect } from 'react';
import {
  cleanupAudio,
  createAudioContext,
  formatMicrophoneError,
  requestMicrophone,
} from '@/lib/audioPermissions';
import {
  SILENCE_RMS,
  PITCH_TOLERANCE_CENTS,
  ONSET_WINDOW_MS,
  rmsFloat,
  dbEnergy,
  detectPitchAC,
  centsDiff,
  clamp100,
  scoreRhythm,
  scoreTechnique,
  scorePitchFrame,
  applyMissPenalty,
} from '@/lib/vocalScoring';

// ─── Types (identical interface to original — nothing else in the app breaks) ──


interface VocalsComparisonMetrics {
  pitchMatch: number;       // 0–100
  rhythmMatch: number;      // 0–100
  techniqueMatch: number;   // 0–100
  volume: number;           // 0–1 current user volume
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

// ─── Constants ────────────────────────────────────────────────────────────────

const FFT_SIZE = 2048;
const HISTORY_FRAMES = 60;          // ~1 second of frames at 60fps
const SCORE_SMOOTHING = 0.15;       // how fast displayed scores change (0=frozen,1=instant)



// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVocalsComparison(options: UseVocalsComparisonOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>({
    pitchMatch: 0,
    rhythmMatch: 0,
    techniqueMatch: 0,
    volume: 0,
    isVoiceDetected: false,
    referenceActive: false,
  });

  // ── User mic refs ──
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

  // ── Reference vocals refs ──
  const refAudioCtxRef = useRef<AudioContext | null>(null);
  const refAnalyserRef = useRef<AnalyserNode | null>(null);
  const refSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refAudioRef = useRef<HTMLAudioElement | null>(null);
  const refKeepAliveRef = useRef<GainNode | null>(null);

  // ── Scoring accumulators (reset each song) ──
  // Pitch: running totals for weighted average
  const pitchScoreAccRef = useRef(0);       // accumulated weighted pitch score
  const pitchFramesRef = useRef(0);         // frames where ref was singing
  const missedFramesRef = useRef(0);        // ref singing, user silent
  // Rhythm: onset lists
  const userOnsetsRef = useRef<number[]>([]); // timestamps ms
  const refOnsetsRef = useRef<number[]>([]);
  const lastUserOnsetRef = useRef(0);
  const lastRefOnsetRef = useRef(0);
  // Technique: sustain + smoothness tracking
  const userEnergyHistRef = useRef<number[]>([]);
  const refEnergyHistRef = useRef<number[]>([]);
  // Displayed scores (smoothed)
  const smoothPitchRef = useRef(0);
  const smoothRhythmRef = useRef(0);
  const smoothTechRef = useRef(0);
  // Previous frame state for onset detection
  const prevUserSilentRef = useRef(true);
  const prevRefSilentRef = useRef(true);

  // ─── Connect user stream to analyser ───────────────────────────────────────

  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    if (!ctx || !analyser) return;

    try { userSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { userGainRef.current?.disconnect(); } catch { /* ignore */ }

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 10; // boost for analysis only

    source.connect(gain);
    gain.connect(analyser);

    // Keep-alive: some browsers won't process graph unless connected to destination
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

  // ─── Init reference vocals analysis ────────────────────────────────────────

  const initRefAnalysis = useCallback(async () => {
    if (!options.vocalsUrl) return;
    try {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = options.vocalsUrl;
      audio.volume = 0;
      audio.preload = 'auto';
      refAudioRef.current = audio;

      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') await ctx.resume();
      refAudioCtxRef.current = ctx;

      await new Promise<void>((resolve) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => resolve(); // don't block on error
        setTimeout(resolve, 3000);
      });

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5; // less smoothing = faster onset detection
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
  }, [options.vocalsUrl]);

  // Re-init if vocalsUrl arrives after startAnalysis
  useEffect(() => {
    if (isActive && options.vocalsUrl && !refAudioRef.current) {
      initRefAnalysis();
    }
  }, [isActive, options.vocalsUrl, initRefAnalysis]);

  // Sync reference audio with main playback
  useEffect(() => {
    const audio = refAudioRef.current;
    if (!audio) return;
    if (options.isPlaying) {
      audio.currentTime = options.currentTime ?? 0;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [options.isPlaying, options.currentTime]);

  // ─── Compute rhythm score from accumulated onsets ──────────────────────────

  const computeRhythmScore = useCallback((): number => {
    return scoreRhythm(userOnsetsRef.current, refOnsetsRef.current);
  }, []);


  // ─── Compute technique score from energy histories ─────────────────────────

  const computeTechniqueScore = useCallback((): number => {
    return scoreTechnique(userEnergyHistRef.current, refEnergyHistRef.current);
  }, []);


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
      await initRefAnalysis();

      // Pre-allocate typed arrays (avoids GC pressure in the loop)
      const freqByte = new Uint8Array(analyser.frequencyBinCount);
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);

      let frameCount = 0;

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;

        // ── User mic readings ──
        userAnalyserRef.current.getByteFrequencyData(freqByte);
        userAnalyserRef.current.getFloatTimeDomainData(timeFloat);
        userAnalyserRef.current.getFloatFrequencyData(freqDb);

        const userRms = rmsFloat(timeFloat);
        const userDbE = dbEnergy(freqDb);
        // Use strongest signal estimator (handles Windows driver quirks)
        const userVolume = Math.max(userRms, userDbE * 0.4);

        // Adaptive noise floor
        if (Number.isFinite(userVolume)) {
          const nf = noiseFloorRef.current;
          const candidate = userVolume < 0.03 ? userVolume : nf;
          noiseFloorRef.current = nf * 0.98 + candidate * 0.02;
        }
        const voiceThreshold = Math.max(0.005, noiseFloorRef.current * 4);
        const isVoiceDetected = userVolume > voiceThreshold;

        // Pitch: autocorrelation (accurate)
        const userPitch = detectPitchAC(timeFloat, userAudioCtxRef.current.sampleRate);

        // Auto-fallback to raw constraints for persistently quiet mic paths
        if (!didFallbackRef.current) {
          if (userVolume < voiceThreshold * 0.6) {
            lowSignalFramesRef.current++;
          } else {
            lowSignalFramesRef.current = 0;
          }
          if (lowSignalFramesRef.current > 120) {
            didFallbackRef.current = true;
            lowSignalFramesRef.current = 0;
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            }).then(raw => {
              userStreamRef.current?.getTracks().forEach(t => t.stop());
              userStreamRef.current = raw;
              connectUserStream(raw);
            }).catch(() => {});
          }
        }

        // Track user energy history
        userEnergyHistRef.current.push(userRms);
        if (userEnergyHistRef.current.length > HISTORY_FRAMES * 5) {
          userEnergyHistRef.current.shift();
        }

        // Onset detection for user: silence→sound transition
        const userIsSilent = userVolume <= voiceThreshold;
        if (prevUserSilentRef.current && !userIsSilent) {
          const now = performance.now();
          if (now - lastUserOnsetRef.current > 100) { // debounce 100ms
            userOnsetsRef.current.push(now);
            lastUserOnsetRef.current = now;
            if (userOnsetsRef.current.length > 200) userOnsetsRef.current.shift();
          }
        }
        prevUserSilentRef.current = userIsSilent;

        // ── Reference vocals readings ──
        let refPitch = 0;
        let refVolume = 0;
        let referenceActive = false;

        if (refAnalyserRef.current && refAudioCtxRef.current) {
          const refTimeFloat = new Float32Array(refAnalyserRef.current.fftSize);
          const refFreqByte = new Uint8Array(refAnalyserRef.current.frequencyBinCount);

          refAnalyserRef.current.getFloatTimeDomainData(refTimeFloat);
          refAnalyserRef.current.getByteFrequencyData(refFreqByte);

          refVolume = rmsFloat(refTimeFloat);
          referenceActive = refVolume > SILENCE_RMS;

          if (referenceActive) {
            refPitch = detectPitchAC(refTimeFloat, refAudioCtxRef.current.sampleRate);
          }

          // Track reference energy history
          refEnergyHistRef.current.push(refVolume);
          if (refEnergyHistRef.current.length > HISTORY_FRAMES * 5) {
            refEnergyHistRef.current.shift();
          }

          // Onset detection for reference
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

        // ── Per-frame pitch scoring ──
        if (referenceActive) {
          pitchFramesRef.current++;

          if (!isVoiceDetected) {
            // Reference singing, user silent → missed frame
            missedFramesRef.current++;
            // Accumulate 0 for this frame
            pitchScoreAccRef.current += 0;
          } else {
            // Both singing — score in cents
            const cents = centsDiff(userPitch, refPitch);
            let frameScore: number;
            if (cents <= PITCH_TOLERANCE_CENTS) {
              // Within tolerance: full marks, scaled to how close
              frameScore = 100 - (cents / PITCH_TOLERANCE_CENTS) * 20; // 80–100
            } else if (cents <= PITCH_TOLERANCE_CENTS * 2) {
              // Slightly off: partial marks
              frameScore = 40 + (1 - (cents - PITCH_TOLERANCE_CENTS) / PITCH_TOLERANCE_CENTS) * 40; // 40–80
            } else if (cents <= PITCH_TOLERANCE_CENTS * 4) {
              // Quite off: low marks
              frameScore = 10 + (1 - (cents - PITCH_TOLERANCE_CENTS * 2) / (PITCH_TOLERANCE_CENTS * 2)) * 30; // 10–40
            } else {
              // Way off or undetected pitch against singing ref
              frameScore = 5;
            }
            pitchScoreAccRef.current += frameScore;
          }
        }

        // ── Compute current scores ──
        const totalSingFrames = pitchFramesRef.current;

        // Raw pitch: weighted average of frame scores
        // Missed frames contribute 0, so they naturally bring the score down
        const rawPitch = totalSingFrames > 0
          ? pitchScoreAccRef.current / totalSingFrames
          : 0;

        // Extra penalty for high missed-frame ratio
        const missRatio = totalSingFrames > 0
          ? missedFramesRef.current / totalSingFrames
          : 0;
        const pitchWithMissPenalty = rawPitch * (1 - missRatio * 0.5);

        // Rhythm: recomputed from onset lists (cheap)
        const rawRhythm = computeRhythmScore();

        // Technique: from energy histories
        const rawTech = computeTechniqueScore();

        // Smooth displayed scores (prevents flickering)
        smoothPitchRef.current = smoothPitchRef.current * (1 - SCORE_SMOOTHING)
          + pitchWithMissPenalty * SCORE_SMOOTHING;
        smoothRhythmRef.current = smoothRhythmRef.current * (1 - SCORE_SMOOTHING)
          + rawRhythm * SCORE_SMOOTHING;
        smoothTechRef.current = smoothTechRef.current * (1 - SCORE_SMOOTHING)
          + rawTech * SCORE_SMOOTHING;

        // Debug log every ~1s
        frameCount++;
        if (frameCount % 60 === 0) {
          console.log('[vocals-comparison] frame:', {
            userVol: userVolume.toFixed(4),
            userPitch: userPitch.toFixed(1),
            refPitch: refPitch.toFixed(1),
            refActive: referenceActive,
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
        options.onMetricsUpdate?.(newMetrics);

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
  }, [
    connectUserStream,
    initRefAnalysis,
    computeRhythmScore,
    computeTechniqueScore,
    options,
  ]);

  // ─── Stop ──────────────────────────────────────────────────────────────────

  const stopAnalysis = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    cleanupAudio(userStreamRef.current, userAudioCtxRef.current);
    userStreamRef.current = null;
    userAudioCtxRef.current = null;
    userAnalyserRef.current = null;
    userGainRef.current = null;
    userKeepAliveRef.current = null;
    userSourceRef.current = null;

    if (refAudioRef.current) {
      refAudioRef.current.pause();
      refAudioRef.current = null;
    }
    if (refAudioCtxRef.current) {
      refAudioCtxRef.current.close();
      refAudioCtxRef.current = null;
    }
    refKeepAliveRef.current = null;

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
      pitchMatch: 0,
      rhythmMatch: 0,
      techniqueMatch: 0,
      volume: 0,
      isVoiceDetected: false,
      referenceActive: false,
    });
  }, []);

  // ─── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => { stopAnalysis(); };
  }, [stopAnalysis]);

  return {
    isActive,
    hasPermission,
    error,
    metrics,
    startAnalysis,
    stopAnalysis,
    resetScores,
  };
}
