// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { durationFits, linesFromRecord, pickBestResult } from '@/lib/lyricsClient';

const lrc = (n: number) => Array.from({ length: n }, (_, i) => `[00:${String(10 + i * 4).padStart(2, '0')}.00] placeholder line ${i}`).join('\n');
const rec = (id: number, duration: number, synced = true) => ({
  id, trackName: 'He Ram He Ram', artistName: 'Jagjit Singh', albumName: 'Album', duration,
  syncedLyrics: synced ? lrc(10) : null, plainLyrics: Array.from({ length: 10 }, (_, i) => `placeholder line ${i}`).join('\n'),
});

describe('lyrics must match the version being sung', () => {
  it('length tolerance: 10 s or 10 %, whichever is larger', () => {
    expect(durationFits(253, 260)).toBe(true);
    expect(durationFits(253, 270)).toBe(true);      // 17 s off, within 10 % (25.3 s)
    expect(durationFits(253, 290)).toBe(false);     // 37 s off
    expect(durationFits(1617, 1700)).toBe(true);     // 27-min song: 161 s tolerance
    expect(durationFits(1617, 253)).toBe(false);     // the 4:13 record for the 27-min version
    expect(durationFits(undefined, 253)).toBe(true);
  });
  it('a record of the right length gives synced lines', () => {
    const r = linesFromRecord(rec(1, 253), 255)!;
    expect(r).toMatchObject({ synced: true, mismatch: false, lrclibId: 1 });
    expect(r.lyrics[0].time).toBe(10);
  });
  it('a record of the wrong length gives text without timing, flagged', () => {
    const r = linesFromRecord(rec(2, 253), 1617)!;
    expect(r).toMatchObject({ synced: false, mismatch: true, lrclibId: 2 });
    expect(r.lyrics[0].text).toBe('placeholder line 0');
  });
  it('selection prefers synced lyrics that fit this version over closer-titled wrong-length ones', () => {
    const pick = pickBestResult([rec(10, 253), rec(11, 1620)] as any, 'He Ram He Ram', 1617, 'hindi', 'Album')!;
    expect(pick.lrclibId).toBe(11);
    expect(pick.synced).toBe(true);
  });
  it('only wrong-length synced lyrics available: text shown without timing, flagged', () => {
    const pick = pickBestResult([rec(20, 253)] as any, 'He Ram He Ram', 1617, 'hindi', 'Album')!;
    expect(pick).toMatchObject({ synced: false, mismatch: true, lrclibId: 20 });
  });
  it('plain lyrics beat wrong-length synced lyrics', () => {
    const pick = pickBestResult([rec(30, 253), rec(31, 1600, false)] as any, 'He Ram He Ram', 1617, 'hindi', 'Album')!;
    expect(pick.lrclibId).toBe(31);
    expect(pick.mismatch).toBe(false);
  });
});
