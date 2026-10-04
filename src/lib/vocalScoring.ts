// src/lib/vocalScoring.ts
// =============================================================================
// Single source of truth for singing scores. Pure TypeScript, no Web Audio,
// fully unit-testable. useVocalsComparison feeds it one analysis frame at a
// time; Sing.tsx only displays and submits what SessionScorer reports.
//
// SCORE = 10 x weighted average of three session components (0-100 each):
//   Accuracy   (50%) — how close your pitch is to the original singer's,
//                      averaged over every scored frame (a TRUE average, so
//                      the start of the song counts no more than the end).
//   Flow       (25%) — how close each of your phrase starts is to the
//                      original's, credited once per reference phrase start.
//   Expression (25%) — 60% presence (you sang while the singer sang)
//                      + 40% steadiness within held notes (pitch wobble per
//                      second; note changes are excluded, so melody is fine).
// A component with no data yet is left out and the weights are renormalised.
// Nothing is reported (components null, total 0) until MIN_SCORED_MS of
// singing has been scored, so a short false detection can't show a score.
//
// A frame is SCORED only when the caller says the scoring window is open
// (lyrics started, inside a vocal section, song playing) AND the reference
// vocal is active AND your voice is detected. "Voice detected" means your
// mic level is 10x above the room's noise floor (NoiseFloorTracker) AND the
// sound is clearly pitched (detectPitch clarity), so room noise, fans, hum,
// typing and clicks never count. Silence earns nothing; there are no
// penalties anywhere.
//
// Calibration constants marked (assumption) are reasoned starting points,
// not yet fitted to telemetry; submit-score stores the raw signals needed to
// refit them.
// =============================================================================

// ─── Shared constants ────────────────────────────────────────────────────────

export const SILENCE_RMS = 0.015;          // below this a frame has no pitch
export const PITCH_TOLERANCE_CENTS = 100;  // 1 semitone = full-credit band
export const ONSET_WINDOW_MS = 400;        // phrase-start matching window
export const ONSET_DEBOUNCE_MS = 100;      // min gap between two onsets
export const NOTE_CHANGE_CENTS = 80;       // frame-to-frame jump treated as a new note
export const STABILITY_FULL_CENTS_PER_S = 600;   // (assumption) at/below: fully steady
export const STABILITY_ZERO_CENTS_PER_S = 2400;  // (assumption) at/above: no steadiness credit
export const REF_PITCH_UNKNOWN_CREDIT = 40; // singing while the reference pitch is undetectable
const MAX_FRAME_GAP_MS = 100;              // longer gaps break a held note
export const MIN_SCORED_MS = 3000;         // no score until 3 s of real singing (a blip of a
                                           // few frames must never produce a big average)

// Voice detection: what counts as "you are singing" (hook uses these).
export const VOICE_MIN_LEVEL = 0.018;      // absolute floor on the threshold (very quiet rooms)
export const VOICE_FLOOR_RATIO = 4;        // must be 4x (12 dB) above the room's noise floor; the
                                           // clarity check below rejects noise, so 20 dB isn't needed
                                           // (20 dB muted real singers ~16 dB above a humming room)
export const VOICE_MIN_CLARITY = 0.75;     // (assumption) YIN clarity needed to count as singing;
                                           // noise/typing/clicks are aperiodic and fall below it

export const SCORE_WEIGHTS = { accuracy: 0.5, flow: 0.25, expression: 0.25 } as const;

export type RatingLetter = 'L' | 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
const RATING_THRESHOLDS: Array<[number, RatingLetter]> = [
  [900, 'L'], [800, 'S'], [700, 'A'], [600, 'B'], [500, 'C'], [300, 'D'],
];
export function ratingForScore(score: number): RatingLetter {
  for (const [min, letter] of RATING_THRESHOLDS) if (score >= min) return letter;
  return 'F';
}

export function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// ─── Signal helpers ──────────────────────────────────────────────────────────

/** RMS of Float32 time-domain samples. */
export function rmsFloat(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / data.length);
}

/** Average linear energy (0..1) from a dB-scale spectrum. */
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
 * YIN pitch detection (de Cheveigné & Kawahara 2002), 60-1050 Hz.
 * Returns the pitch in Hz (0 = silent/unpitched) and its clarity
 * (1 - normalised difference at the chosen lag; ~0.9+ for a sung vowel,
 * low for noise). Clarity is what separates singing from room noise.
 */
export function detectPitch(samples: Float32Array, sampleRate: number): { hz: number; clarity: number } {
  const len = samples.length;
  if (rmsFloat(samples) < SILENCE_RMS) return { hz: 0, clarity: 0 };

  const minLag = Math.floor(sampleRate / 1050);
  const maxLag = Math.floor(sampleRate / 60);
  const cmndf = new Float32Array(maxLag + 1);
  let runningSum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let diff = 0;
    for (let i = 0; i < len - lag; i++) {
      const d = samples[i] - samples[i + lag];
      diff += d * d;
    }
    runningSum += diff;
    cmndf[lag] = runningSum > 0 ? (diff * lag) / runningSum : 1;
  }

  // First dip below the threshold (then walk to its local minimum) avoids
  // the sub-harmonic picks a global minimum would make.
  const THRESHOLD = 0.10;
  let picked = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmndf[lag] < THRESHOLD) {
      while (lag + 1 <= maxLag && cmndf[lag + 1] < cmndf[lag]) lag++;
      picked = lag;
      break;
    }
  }
  if (picked < 0) {
    let best = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmndf[lag] < best) { best = cmndf[lag]; picked = lag; }
    }
    if (best > 0.5) return { hz: 0, clarity: 0 };
  }
  const clarity = 1 - cmndf[picked];

  let refined = picked;
  if (picked > minLag && picked < maxLag) {
    const a = cmndf[picked - 1];
    const b = cmndf[picked];
    const c = cmndf[picked + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) refined += (0.5 * (a - c)) / denom;
  }
  return { hz: sampleRate / refined, clarity };
}

/** Pitch only (Hz, 0 = none). Used for the reference vocals. */
export function detectPitchAC(samples: Float32Array, sampleRate: number): number {
  return detectPitch(samples, sampleRate).hz;
}

/** Cents between two pitches, folded to the nearest octave (0..600). */
export function centsDiff(hz1: number, hz2: number): number {
  if (hz1 <= 0 || hz2 <= 0) return Infinity;
  const folded = Math.abs(1200 * Math.log2(hz1 / hz2)) % 1200;
  return folded > 600 ? 1200 - folded : folded;
}

// ─── Per-event scores ────────────────────────────────────────────────────────

/** Accuracy credit for one frame where both pitches are known. 0..100. */
export function scorePitchFrame(userHz: number, refHz: number, tol = PITCH_TOLERANCE_CENTS): number {
  const c = centsDiff(userHz, refHz);
  if (c <= tol) return 85 + (1 - c / tol) * 15;                       // 85-100 within 1 semitone
  if (c <= tol * 2) return 45 + (1 - (c - tol) / tol) * 40;           // 45-85 at 1-2 semitones
  if (c <= tol * 4) return 10 + (1 - (c - tol * 2) / (tol * 2)) * 35; // 10-45 at 2-4 semitones
  return 5;                                                           // wrong note, minimal credit
}

/** Flow credit (0..1) for a phrase start that is `deltaMs` early or late. */
export function onsetCredit(deltaMs: number): number {
  const d = Math.abs(deltaMs);
  if (d <= 200) return 1 - (d / 200) * 0.5;                        // 100% -> 50%
  if (d <= ONSET_WINDOW_MS) return 0.5 - ((d - 200) / 200) * 0.4;  // 50% -> 10%
  return 0;
}

/** Steadiness (0..100) from mean within-note pitch movement in cents/second. */
export function stabilityScore(centsPerSecond: number): number {
  const span = STABILITY_ZERO_CENTS_PER_S - STABILITY_FULL_CENTS_PER_S;
  return clamp100(100 * (STABILITY_ZERO_CENTS_PER_S - centsPerSecond) / span);
}

/** Combine components into the 0-1000 total; null components are left out. */
export function combineScore(c: { accuracy: number | null; flow: number | null; expression: number | null }): number {
  let sum = 0;
  let weight = 0;
  if (c.accuracy !== null) { sum += c.accuracy * SCORE_WEIGHTS.accuracy; weight += SCORE_WEIGHTS.accuracy; }
  if (c.flow !== null) { sum += c.flow * SCORE_WEIGHTS.flow; weight += SCORE_WEIGHTS.flow; }
  if (c.expression !== null) { sum += c.expression * SCORE_WEIGHTS.expression; weight += SCORE_WEIGHTS.expression; }
  if (c.accuracy === null || weight === 0) return 0; // nothing sung yet
  return Math.max(0, Math.min(1000, Math.round((sum / weight) * 10)));
}

// ─── Reference melody (pitch.json from Modal) ───────────────────────────────

/**
 * The original singer's melody, computed once per song on Modal (pitch.py,
 * CREPE) and stored next to the stems. When present, scoring compares you
 * against this clean melody instead of guessing the singer's pitch live from
 * the vocal stem (which picks up separation leftovers, backing vocals and
 * harmonies). c[i] = MIDI note x 100 at time i x hopMs, 0 = not singing.
 */
export interface PitchContour {
  hopMs: number;
  cents: Int32Array;
}

/** Validate and unpack pitch.json. Returns null for anything malformed. */
export function parsePitchContour(raw: unknown): PitchContour | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { v?: unknown; hop_ms?: unknown; c?: unknown };
  if (r.v !== 1 || typeof r.hop_ms !== 'number' || !(r.hop_ms > 0) || !Array.isArray(r.c) || r.c.length === 0) return null;
  const cents = new Int32Array(r.c.length);
  for (let i = 0; i < r.c.length; i++) {
    const v = r.c[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 13000) return null;
    cents[i] = Math.round(v);
  }
  return { hopMs: r.hop_ms, cents };
}

/** Original singer's pitch in Hz at song time tSec (0 = not singing / outside the song). */
export function contourPitchAt(contour: PitchContour, tSec: number): number {
  if (!(tSec >= 0)) return 0;
  const i = Math.round((tSec * 1000) / contour.hopMs);
  if (i >= contour.cents.length) return 0;
  const c = contour.cents[i];
  return c > 0 ? 440 * Math.pow(2, (c / 100 - 69) / 12) : 0;
}

// ─── Noise floor ─────────────────────────────────────────────────────────────

/**
 * Room noise level = the 5th percentile of the mic level over the last 10 s:
 * the level the room sits at for at least half a second in every ten.
 *  - Adapts to ANY noise level (no absolute cut-off), so a fan/AC/hum or
 *    auto-gain boosted room is learned within ~10 s of the mic starting —
 *    normally during the song intro, before scoring opens at the first lyric.
 *  - Singing doesn't drag it up: any 10 s of singing contains breaths and
 *    gaps, and even a long held note still leaves the quiet 5%.
 * Replaces the old rule that only learned from frames below an absolute 0.03:
 * once a room's (auto-gain boosted) noise sat above 0.03 the floor froze at
 * its start value and steady room sounds counted as singing.
 */
export class NoiseFloorTracker {
  static readonly WINDOW_MS = 10000;
  static readonly PERCENTILE = 0.05;
  static readonly RECOMPUTE_MS = 250;
  private times: number[] = [];
  private levels: number[] = [];
  private cached = 0;
  private lastCompute = -Infinity;

  reset(): void { this.times = []; this.levels = []; this.cached = 0; this.lastCompute = -Infinity; }

  update(level: number, t: number): void {
    if (!Number.isFinite(level)) return;
    this.times.push(t);
    this.levels.push(level);
    const cutoff = t - NoiseFloorTracker.WINDOW_MS;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop++;
    if (drop) { this.times.splice(0, drop); this.levels.splice(0, drop); }
    if (t - this.lastCompute >= NoiseFloorTracker.RECOMPUTE_MS) {
      const sorted = [...this.levels].sort((x, y) => x - y);
      this.cached = sorted[Math.floor((sorted.length - 1) * NoiseFloorTracker.PERCENTILE)];
      this.lastCompute = t;
    }
  }

  get floor(): number { return this.cached; }

  get voiceThreshold(): number {
    return Math.max(VOICE_MIN_LEVEL, this.cached * VOICE_FLOOR_RATIO);
  }
}

// ─── Session scorer ──────────────────────────────────────────────────────────

export interface ScoreFrame {
  t: number;             // ms timestamp of this frame (performance.now())
  scoringOpen: boolean;  // caller's window: lyrics started, vocal section, playing
  refActive: boolean;    // reference vocal audible
  refPitch: number;      // Hz, 0 = unknown (only needed when refActive)
  userVoiced: boolean;   // your voice above the detection threshold
  userPitch: number;     // Hz, 0 = unknown (only needed when userVoiced)
}

export interface SessionSnapshot {
  accuracy: number | null;    // 0-100, null until something is scored
  flow: number | null;        // 0-100, null until a reference phrase start resolves
  expression: number | null;  // 0-100, null until the reference has been active
  total: number;              // 0-1000
  rating: RatingLetter;
  scoredFrames: number;       // frames that counted toward Accuracy
  voicedFrames: number;       // frames you sang while the reference was active
  refActiveFrames: number;    // frames the reference was active (window open)
  completion: number | null;  // voicedFrames / refActiveFrames
}

export class SessionScorer {
  private accSum = 0;
  private accFrames = 0;
  private scoredMs = 0;        // time spent singing (scored frames), frame-rate independent
  private lastFrameT = -1;
  private refActiveFrames = 0;
  private voicedFrames = 0;
  private pitchedFrames = 0;
  private jitterSum = 0;       // sum of within-note cents/second
  private jitterSamples = 0;
  private prevPitchedT = -1;   // last scored frame with your pitch known
  private prevPitchedHz = 0;
  private flowCredit = 0;
  private flowResolved = 0;
  private pendingRef: number[] = [];  // reference phrase starts awaiting their window
  private userOnsets: number[] = [];  // your recent phrase starts
  private usedUser = new Set<number>();
  private prevRefActive = false;
  private prevUserVoiced = false;
  private lastRefOnset = -Infinity;
  private lastUserOnset = -Infinity;

  reset(): void {
    Object.assign(this, new SessionScorer());
  }

  frame(f: ScoreFrame): void {
    const open = f.scoringOpen;
    const dt = this.lastFrameT >= 0 ? Math.min(MAX_FRAME_GAP_MS, Math.max(0, f.t - this.lastFrameT)) : 0;
    this.lastFrameT = f.t;

    // Phrase starts: off->on transitions, recorded only inside the window.
    const refStart = open && f.refActive && !this.prevRefActive && f.t - this.lastRefOnset > ONSET_DEBOUNCE_MS;
    const userStart = open && f.userVoiced && !this.prevUserVoiced && f.t - this.lastUserOnset > ONSET_DEBOUNCE_MS;
    if (refStart) { this.pendingRef.push(f.t); this.lastRefOnset = f.t; }
    if (userStart) { this.userOnsets.push(f.t); this.lastUserOnset = f.t; }
    this.prevRefActive = f.refActive;
    this.prevUserVoiced = f.userVoiced;
    this.resolveOnsets(f.t, false);

    if (!open || !f.refActive) { this.prevPitchedT = -1; return; }

    this.refActiveFrames++;
    if (!f.userVoiced) { this.prevPitchedT = -1; return; }
    this.voicedFrames++;

    // Accuracy
    if (f.userPitch > 0 && f.refPitch > 0) {
      this.accSum += scorePitchFrame(f.userPitch, f.refPitch);
      this.accFrames++;
      this.scoredMs += dt;
    } else if (f.userPitch > 0) {
      this.accSum += REF_PITCH_UNKNOWN_CREDIT;
      this.accFrames++;
      this.scoredMs += dt;
    }

    // Expression: presence + within-note steadiness
    if (f.userPitch > 0) {
      this.pitchedFrames++;
      const gap = f.t - this.prevPitchedT;
      if (this.prevPitchedT >= 0 && gap > 0 && gap <= MAX_FRAME_GAP_MS) {
        const jump = Math.abs(1200 * Math.log2(f.userPitch / this.prevPitchedHz));
        if (jump < NOTE_CHANGE_CENTS) {
          this.jitterSum += jump / (gap / 1000);
          this.jitterSamples++;
        }
      }
      this.prevPitchedT = f.t;
      this.prevPitchedHz = f.userPitch;
    } else {
      this.prevPitchedT = -1;
    }
  }

  /** Score every reference phrase start whose matching window has passed (all, if final). */
  private resolveOnsets(now: number, final: boolean): void {
    while (this.pendingRef.length && (final || now - this.pendingRef[0] > ONSET_WINDOW_MS)) {
      const r = this.pendingRef.shift()!;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.userOnsets.length; i++) {
        const u = this.userOnsets[i];
        if (this.usedUser.has(u)) continue;
        const d = Math.abs(u - r);
        if (d < bestD) { bestD = d; best = i; }
      }
      const credit = best >= 0 ? onsetCredit(bestD) : 0;
      if (credit > 0) this.usedUser.add(this.userOnsets[best]);
      this.flowCredit += credit;
      this.flowResolved++;
    }
    // Keep only your onsets that could still match a future reference start.
    const cutoff = now - 2 * ONSET_WINDOW_MS;
    while (this.userOnsets.length && this.userOnsets[0] < cutoff) {
      this.usedUser.delete(this.userOnsets.shift()!);
    }
  }

  /** Resolve any pending phrase starts (call at song end before the final snapshot). */
  finalize(now: number): void {
    this.resolveOnsets(now, true);
  }

  snapshot(): SessionSnapshot {
    const enough = this.scoredMs >= MIN_SCORED_MS;
    const accuracy = enough && this.accFrames > 0 ? this.accSum / this.accFrames : null;
    const flow = enough && this.flowResolved > 0 ? (this.flowCredit / this.flowResolved) * 100 : null;
    let expression: number | null = null;
    if (enough && this.refActiveFrames > 0) {
      const presence = Math.min(1, this.pitchedFrames / this.refActiveFrames) * 100;
      // Without enough held-note samples steadiness can't be judged, so only
      // the presence part (60%) is awarded.
      expression = this.jitterSamples >= 10
        ? 0.6 * presence + 0.4 * stabilityScore(this.jitterSum / this.jitterSamples)
        : 0.6 * presence;
    }
    const total = combineScore({ accuracy, flow, expression });
    return {
      accuracy, flow, expression, total,
      rating: ratingForScore(total),
      scoredFrames: this.accFrames,
      voicedFrames: this.voicedFrames,
      refActiveFrames: this.refActiveFrames,
      completion: this.refActiveFrames > 0 ? this.voicedFrames / this.refActiveFrames : null,
    };
  }
}

/** Sine wave buffer — test helper. */
export function sineBuffer(hz: number, sampleRate: number, length: number, amp = 0.5): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < length; i++) out[i] = amp * Math.sin(w * i);
  return out;
}
