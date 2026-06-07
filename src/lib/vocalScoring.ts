// Pure DSP + scoring helpers extracted from useVocalsComparison.
// These are deterministic and unit-testable (no Web Audio dependencies).

export const SILENCE_RMS = 0.015;
export const PITCH_TOLERANCE_CENTS = 60;
export const ONSET_WINDOW_MS = 180;

/** RMS from Float32 time-domain samples. */
export function rmsFloat(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / data.length);
}

/** Average linear energy from a dB-scale float array (0..1). */
export function dbEnergy(data: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    s += Math.pow(10, v / 20);
    n++;
  }
  return n > 0 ? Math.min(1, s / n) : 0;
}

/**
 * Autocorrelation pitch detection — proper YIN algorithm (de Cheveigné & Kawahara 2002).
 *
 * FIX vs previous version: the old code found the GLOBAL minimum of the SDF,
 * which always landed on the sub-harmonic (half/third the true frequency).
 * Correct YIN finds the FIRST lag that crosses below a confidence threshold,
 * then slides to the local valley — this reliably picks the fundamental.
 *
 * Returns Hz or 0 if silent / unpitched.
 */
export function detectPitchAC(samples: Float32Array, sampleRate: number): number {
  const len = samples.length;

  // RMS gate — skip silent frames
  let sumSq = 0;
  for (let i = 0; i < len; i++) sumSq += samples[i] * samples[i];
  if (Math.sqrt(sumSq / len) < SILENCE_RMS) return 0;

  // Search range: 60 Hz – 1050 Hz (covers full human vocal range)
  const minLag = Math.floor(sampleRate / 1050);
  const maxLag = Math.floor(sampleRate / 60);

  // ── Step 1: Squared Difference Function (SDF) ──
  // d[lag] = sum_i (x[i] - x[i+lag])^2
  const sdf = new Float32Array(maxLag + 1);
  sdf[0] = 0;

  // ── Step 2: Cumulative Mean Normalised Difference Function (CMNDF) ──
  // This normalises d[lag] so it's 1 at lag=0 and trends toward 1 for noise.
  // A true periodic signal dips sharply toward 0 at integer multiples of its period.
  let runningSum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let diff = 0;
    for (let i = 0; i < len - lag; i++) {
      const d = samples[i] - samples[i + lag];
      diff += d * d;
    }
    runningSum += diff;
    // CMNDF: normalise by cumulative mean so all lags are comparable
    sdf[lag] = runningSum > 0 ? (diff * lag) / runningSum : 1;
  }

  // ── Step 3: Absolute threshold ──
  // Find the FIRST lag >= minLag where CMNDF dips below 0.10 (high confidence).
  // Then slide right to the local minimum of that dip.
  // This is the key fix: global-min search picks sub-harmonics; threshold-first does not.
  const THRESHOLD = 0.10;
  let pickedLag = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    if (sdf[lag] < THRESHOLD) {
      // Slide to bottom of this valley
      while (lag + 1 <= maxLag && sdf[lag + 1] < sdf[lag]) lag++;
      pickedLag = lag;
      break;
    }
  }

  // ── Fallback: global minimum (for signals that never cross threshold) ──
  if (pickedLag < 0) {
    let best = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (sdf[lag] < best) { best = sdf[lag]; pickedLag = lag; }
    }
    // Reject if the best we found is still too noisy (unpitched)
    if (best > 0.5) return 0;
  }

  if (pickedLag < 0) return 0;

  // ── Step 4: Parabolic interpolation for sub-sample accuracy ──
  let refined = pickedLag;
  if (pickedLag > minLag && pickedLag < maxLag) {
    const alpha = sdf[pickedLag - 1];
    const beta  = sdf[pickedLag];
    const gamma = sdf[pickedLag + 1];
    const denom = alpha - 2 * beta + gamma;
    if (denom !== 0) refined += 0.5 * (alpha - gamma) / denom;
  }

  return sampleRate / refined;
}

/** Absolute cents difference. Infinity if either value is non-positive. */
export function centsDiff(hz1: number, hz2: number): number {
  if (hz1 <= 0 || hz2 <= 0) return Infinity;
  return Math.abs(1200 * Math.log2(hz1 / hz2));
}

export function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/**
 * Pitch score for a single frame where the reference is singing.
 * Returns 0..100. `userVoiceDetected=false` => 0 (missed frame).
 */
export function scorePitchFrame(
  userPitchHz: number,
  refPitchHz: number,
  userVoiceDetected: boolean,
  tolerance = PITCH_TOLERANCE_CENTS,
): number {
  if (!userVoiceDetected) return 0;
  const cents = centsDiff(userPitchHz, refPitchHz);
  if (cents <= tolerance) {
    return 100 - (cents / tolerance) * 20; // 80..100
  }
  if (cents <= tolerance * 2) {
    return 40 + (1 - (cents - tolerance) / tolerance) * 40; // 40..80
  }
  if (cents <= tolerance * 4) {
    return 10 + (1 - (cents - tolerance * 2) / (tolerance * 2)) * 30; // 10..40
  }
  return 5;
}

/**
 * Apply miss-ratio penalty to the raw averaged pitch score.
 * missRatio in [0,1]; max 50% penalty when every reference frame is missed.
 */
export function applyMissPenalty(rawPitch: number, missRatio: number): number {
  return rawPitch * (1 - missRatio * 0.5);
}

/**
 * Greedy onset matcher used for the rhythm score.
 * Mirrors the in-hook implementation so we can verify it deterministically.
 */
export function scoreRhythm(
  userOnsets: number[],
  refOnsets: number[],
  tolerance = ONSET_WINDOW_MS,
): number {
  if (refOnsets.length === 0) return 50;
  if (userOnsets.length === 0) return 0;

  let matched = 0;
  const used = new Set<number>();

  for (const ro of refOnsets) {
    let best = Infinity;
    let bestI = -1;
    for (let i = 0; i < userOnsets.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(userOnsets[i] - ro);
      if (d < best) { best = d; bestI = i; }
    }
    if (best <= tolerance && bestI >= 0) {
      matched += 1 - (best / tolerance) * 0.5;
      used.add(bestI);
    }
  }

  const extra = userOnsets.length - used.size;
  const extraPenalty = Math.min(15, extra * 3);
  const base = (matched / refOnsets.length) * 100;
  return clamp100(base - extraPenalty);
}

/**
 * Technique score from per-frame RMS energy histories.
 * Combines sustain ratio (60%) with breath smoothness (40%).
 */
export function scoreTechnique(
  userEnergy: number[],
  refEnergy: number[],
  silenceRms = SILENCE_RMS,
): number {
  if (userEnergy.length < 5 || refEnergy.length < 5) return 50;

  const refActive = refEnergy.filter((v) => v > silenceRms).length;
  const userActive = userEnergy.filter((v) => v > silenceRms).length;
  const sustainRatio = refActive > 0 ? Math.min(1, userActive / refActive) : 1;

  let smooth = 0;
  for (let i = 1; i < userEnergy.length; i++) {
    const delta = Math.abs(userEnergy[i] - userEnergy[i - 1]);
    const rel = userEnergy[i - 1] > 0 ? delta / userEnergy[i - 1] : 1;
    smooth += rel < 0.4 ? 1 : 0;
  }
  const smoothRatio = smooth / (userEnergy.length - 1);

  return clamp100((sustainRatio * 0.6 + smoothRatio * 0.4) * 100);
}

/** Generate a sine wave Float32 buffer — handy for tests. */
export function sineBuffer(hz: number, sampleRate: number, length: number, amp = 0.5): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < length; i++) out[i] = amp * Math.sin(w * i);
  return out;
}
