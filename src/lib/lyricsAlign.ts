// src/lib/lyricsAlign.ts
// =============================================================================
// Lines up synced lyrics with when the original singer actually sings.
// Lyrics files are often timed for a slightly different release (longer
// intro, different edit), so every line is early or late by the same amount.
// The vocal activity of THIS recording (the reference melody from Modal, or
// the vocal-section map Sing.tsx builds from the vocal stem) shows when
// singing happens. Every shift from -30 s to +30 s (0.1 s steps) is tried and
// the one where lyric lines overlap singing best wins. It is applied ONLY
// when clearly better than leaving the timing alone, so correct lyrics are
// never disturbed. Only for synced lyrics of the right length (see
// lyricsClient durationFits); a different-length version can't be fixed by a
// single shift.
// =============================================================================

import type { LyricLine } from '@/lib/lyricsClient';

export const ALIGN_STEP_S = 0.1;
export const ALIGN_MAX_SHIFT_S = 30;
export const ALIGN_MIN_SCORE = 0.55;        // share of lyric time that overlaps singing after the shift
export const ALIGN_MIN_GAIN = 0.10;         // must beat "no shift" by this much
export const ALIGN_MIN_SHIFT_S = 0.3;       // smaller shifts aren't worth applying
const MAX_LINE_SPAN_S = 6;                  // a line "covers" at most its first 6 s

export interface AlignResult {
  lines: LyricLine[];
  shiftSec: number;      // applied shift (0 when not applied)
  bestShiftSec: number;  // best shift found
  score: number;         // overlap at the best shift (0-1)
  baseScore: number;     // overlap with no shift (0-1)
  applied: boolean;
}

/** Vocal activity sampled every ALIGN_STEP_S from the reference melody (c > 0 = singing). */
export function activityFromContour(cents: ArrayLike<number>, hopMs: number, songSec: number): Uint8Array {
  const n = Math.ceil(songSec / ALIGN_STEP_S);
  const out = new Uint8Array(n);
  for (let i = 0; i < cents.length; i++) {
    if (cents[i] > 0) {
      const k = Math.floor((i * hopMs) / 1000 / ALIGN_STEP_S);
      if (k >= 0 && k < n) out[k] = 1;
    }
  }
  return out;
}

/** Vocal activity sampled every ALIGN_STEP_S from [start, end] second intervals. */
export function activityFromIntervals(intervals: Array<{ start: number; end: number }>, songSec: number): Uint8Array {
  const n = Math.ceil(songSec / ALIGN_STEP_S);
  const out = new Uint8Array(n);
  for (const { start, end } of intervals) {
    for (let k = Math.max(0, Math.floor(start / ALIGN_STEP_S)); k < Math.min(n, Math.ceil(end / ALIGN_STEP_S)); k++) out[k] = 1;
  }
  return out;
}

export function alignLyricsToVocals(lines: LyricLine[], activity: Uint8Array): AlignResult {
  const none = (score = 0, base = 0, best = 0): AlignResult =>
    ({ lines, shiftSec: 0, bestShiftSec: best, score, baseScore: base, applied: false });
  const n = activity.length;
  if (lines.length < 3 || n === 0) return none();
  let active = 0;
  for (let k = 0; k < n; k++) active += activity[k];
  if (active < 10) return none();

  // Sample positions covered by lyric lines (at most MAX_LINE_SPAN_S each).
  const covered: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].time;
    const next = i + 1 < lines.length ? lines[i + 1].time : start + (lines[i].duration ?? 4);
    const end = start + Math.min(MAX_LINE_SPAN_S, Math.max(0.5, next - start));
    for (let k = Math.floor(start / ALIGN_STEP_S); k < Math.ceil(end / ALIGN_STEP_S); k++) covered.push(k);
  }
  if (covered.length === 0) return none();

  const maxSteps = Math.round(ALIGN_MAX_SHIFT_S / ALIGN_STEP_S);
  const scoreAt = (shiftSteps: number) => {
    let hit = 0;
    for (const k of covered) {
      const j = k + shiftSteps;
      if (j >= 0 && j < n && activity[j]) hit++;
    }
    return hit / covered.length;
  };
  const base = scoreAt(0);
  let best = base, bestSteps = 0;
  for (let s = -maxSteps; s <= maxSteps; s++) {
    if (s === 0) continue;
    const sc = scoreAt(s);
    // Strictly better, or equally good but a smaller shift.
    if (sc > best + 1e-9 || (Math.abs(sc - best) <= 1e-9 && Math.abs(s) < Math.abs(bestSteps))) { best = sc; bestSteps = s; }
  }
  const shift = Math.round(bestSteps * ALIGN_STEP_S * 10) / 10;
  const apply = best >= ALIGN_MIN_SCORE && best - base >= ALIGN_MIN_GAIN && Math.abs(shift) >= ALIGN_MIN_SHIFT_S;
  if (!apply) return none(best, base, shift);
  return {
    lines: lines.map(l => ({ ...l, time: Math.max(0, Math.round((l.time + shift) * 100) / 100) })),
    shiftSec: shift, bestShiftSec: shift, score: best, baseScore: base, applied: true,
  };
}
