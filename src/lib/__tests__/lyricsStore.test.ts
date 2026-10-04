// @vitest-environment jsdom
// fetchLyricsCached: shared per-song store first, LRCLIB on a miss (choice saved), version flags.
import { describe, it, expect, vi, beforeEach } from 'vitest';
const invokes: any[] = [];
let stored: any = null;
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: async (_n: string, { body }: any) => {
    invokes.push(body);
    if (body.action === 'lyrics-get') return { data: { record: stored } };
    return { data: { saved: true } };
  } } },
}));
vi.mock('@/lib/lyricsCache', () => ({ getCachedLyricsEntry: async () => null, cacheLyrics: async () => {} }));
import { fetchLyricsCached } from '@/lib/lyricsClient';

const lrc = '[00:12.00] placeholder a\n[00:16.00] placeholder b\n[00:20.00] placeholder c';
const lrclibItem = (id: number, duration: number) => ({ id, trackName: 'Test Song', artistName: 'Test Artist', albumName: 'A', duration, syncedLyrics: lrc, plainLyrics: 'placeholder a\nplaceholder b' });
let lrclibHits = 0;
beforeEach(() => {
  invokes.length = 0; stored = null; lrclibHits = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  globalThis.fetch = vi.fn(async (url: any) => {
    lrclibHits++;
    const u = String(url);
    return new Response(JSON.stringify(u.includes('/api/search') ? [lrclibItem(55, 253)] : lrclibItem(55, 253)));
  }) as any;
});

describe('lyrics store + version flags', () => {
  it('uses the shared store first (no LRCLIB search)', async () => {
    stored = lrclibItem(99, 250);
    const r = await fetchLyricsCached({ trackId: 'tA', title: 'Test Song', artist: 'Test Artist', duration: 252 });
    expect(r).toMatchObject({ synced: true, mismatch: false, lrclibId: 99 });
    expect(lrclibHits).toBe(0);
    expect(invokes.map(i => i.action)).toEqual(['lyrics-get']);
  });
  it('store miss: searches LRCLIB, then saves the chosen record id', async () => {
    const r = await fetchLyricsCached({ trackId: 'tB', title: 'Test Song', artist: 'Test Artist', duration: 254 });
    expect(r.lyrics.length).toBeGreaterThan(0); expect(r.lrclibId).toBe(55);
    await new Promise(res => setTimeout(res, 0));
    expect(invokes.find(i => i.action === 'lyrics-save')).toMatchObject({ trackId: 'tB', lrclibId: 55 });
    expect(lrclibHits).toBeGreaterThan(0);
  });
  it('a stored record of a different length is shown without timing, flagged', async () => {
    stored = lrclibItem(98, 253);
    const r = await fetchLyricsCached({ trackId: 'tC', title: 'Other Song', artist: 'Test Artist', duration: 1617 });
    expect(r).toMatchObject({ synced: false, mismatch: true });
  });
  it('without a trackId there is no store traffic', async () => {
    await fetchLyricsCached({ title: 'Third Song', artist: 'Test Artist', duration: 200 });
    expect(invokes).toHaveLength(0);
  });
});
