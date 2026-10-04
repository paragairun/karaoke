import { describe, it, expect } from 'vitest';
import { mergeResultRows } from '@/lib/searchResults';
const r = (id: string, title: string, duration: string, extra: any = {}) => ({ id, title, artist: 'Jagjit Singh', duration, ...extra });

describe('merging a later source into rows on screen', () => {
  const saavn = [r('s1', 'He Ram He Ram', '4:13'), r('s2', 'Hey Ram', '5:02'), r('s3', 'He Ram He Ram', '26:57')];
  it("a later source's copy joins the matching row; rows never move", () => {
    const out = mergeResultRows(saavn, [r('g1', 'He Ram He Ram (From "X")', '4:15'), r('g2', 'Hare Rama', '6:30')]);
    expect(out.map(x => x.id)).toEqual(['s1', 's2', 's3', 'g2']);
    expect(out[0].altVersions!.map(a => a.id)).toEqual(['g1']);
  });
  it('a Ready copy takes over the row in the same position', () => {
    const out = mergeResultRows(saavn, [r('g3', 'He Ram He Ram', '26:59', { ready: true })]);
    expect(out[2].id).toBe('g3'); expect(out[2].ready).toBe(true);
    expect(out[2].altVersions!.map(a => a.id)).toEqual(['s3']);
  });
  it('same id is ignored; different lengths stay separate', () => {
    const out = mergeResultRows(saavn, [r('s1', 'He Ram He Ram', '4:13'), r('g4', 'He Ram He Ram', '8:44')]);
    expect(out.map(x => x.id)).toEqual(['s1', 's2', 's3', 'g4']);
  });
  it('alternatives from both sides are kept (capped at 6)', () => {
    const rows = [r('a', 'Song', '3:00', { altVersions: [r('a2', 'Song', '3:01')] })];
    const out = mergeResultRows(rows, [r('b', 'Song', '3:02', { altVersions: [r('b2', 'Song', '3:00')] })]);
    expect(out[0].altVersions!.map(a => a.id).sort()).toEqual(['a2', 'b', 'b2']);
  });
});
