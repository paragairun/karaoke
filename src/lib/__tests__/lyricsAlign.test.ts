import { describe, it, expect } from 'vitest';
import { alignLyricsToVocals, activityFromContour, activityFromIntervals, ALIGN_STEP_S } from '@/lib/lyricsAlign';

// A song where the singer sings in phrases; lyric lines start each phrase.
const SONG = 240;
const phrases: Array<{ start: number; end: number }> = [];
for (let t = 20; t < 220; t += 9) phrases.push({ start: t, end: t + 6 });
const lines = (shift: number) => phrases.map((p, i) => ({ time: p.start + shift, text: `placeholder line ${i}`, duration: 9 }));
const activity = activityFromIntervals(phrases, SONG);

describe('lyric timing alignment', () => {
  it('finds and applies a constant shift (lyrics 4.2 s late)', () => {
    const r = alignLyricsToVocals(lines(4.2), activity);
    expect(r.applied).toBe(true);
    expect(Math.abs(r.shiftSec + 4.2)).toBeLessThanOrEqual(ALIGN_STEP_S + 1e-9);
    expect(r.score).toBeGreaterThan(r.baseScore + 0.1);
    expect(Math.abs(r.lines[0].time - phrases[0].start)).toBeLessThanOrEqual(0.11);
  });
  it('finds an early shift too (lyrics 11 s early)', () => {
    const r = alignLyricsToVocals(lines(-11), activity);
    expect(r.applied).toBe(true);
    expect(Math.abs(r.shiftSec - 11)).toBeLessThanOrEqual(ALIGN_STEP_S + 1e-9);
  });
  it('leaves correct lyrics untouched', () => {
    const r = alignLyricsToVocals(lines(0), activity);
    expect(r.applied).toBe(false);
    expect(r.lines).toBe(r.lines);
    expect(r.lines[0].time).toBe(phrases[0].start);
  });
  it('does not apply a shift when the vocals tell nothing (no singing detected)', () => {
    const r = alignLyricsToVocals(lines(5), new Uint8Array(SONG / ALIGN_STEP_S));
    expect(r.applied).toBe(false);
  });
  it('does not apply a shift when vocals are everywhere (no information)', () => {
    const r = alignLyricsToVocals(lines(5), new Uint8Array(SONG / ALIGN_STEP_S).fill(1));
    expect(r.applied).toBe(false);
  });
  it('ignores shifts beyond 30 s', () => {
    const r = alignLyricsToVocals(lines(45), activity);
    expect(Math.abs(r.shiftSec)).toBeLessThanOrEqual(30);
  });
  it('builds activity from the reference melody', () => {
    const cents = new Int32Array(SONG * 50);                      // 20 ms frames
    for (const p of phrases) for (let i = p.start * 50; i < p.end * 50; i++) cents[i] = 6000;
    const act = activityFromContour(cents, 20, SONG);
    const r = alignLyricsToVocals(lines(3), act);
    expect(r.applied).toBe(true);
    expect(Math.abs(r.shiftSec + 3)).toBeLessThanOrEqual(ALIGN_STEP_S + 1e-9);
  });
});
