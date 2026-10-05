// @vitest-environment jsdom
// refreshLyrics: re-runs the selection skipping every cache, overwrites this
// device's copy, and reports what happened to the shared stored lyrics.
import { describe, it, expect, vi, beforeEach } from 'vitest';
const invokes: any[] = [];
let refreshReply: { data?: any; error?: any } = { data: { replaced: true } };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: async (_n: string, { body }: any) => {
    invokes.push(body);
    if (body.action === 'lyrics-get') return { data: { record: { id: 1, duration: 200, syncedLyrics: '[00:05.00] stale stored line', plainLyrics: 'stale stored line' } } };
    if (body.action === 'lyrics-refresh') return refreshReply;
    return { data: {} };
  } } },
}));
const cached: Record<string, any> = {};
vi.mock('@/lib/lyricsCache', () => ({
  getCachedLyricsEntry: async (k: string) => cached[k] ?? null,
  cacheLyrics: async (k: string, lyrics: any, meta: any) => { cached[k] = { lyrics, meta }; },
}));
import { fetchLyricsCached, refreshLyrics } from '@/lib/lyricsClient';

const fresh = { id: 77, trackName: 'Test Song', artistName: 'Test Artist', albumName: 'A', duration: 201,
  syncedLyrics: '[00:10.00] fresh line a\n[00:14.00] fresh line b\n[00:18.00] fresh line c', plainLyrics: 'fresh line a' };
let lrclibHits = 0;
beforeEach(() => {
  invokes.length = 0; lrclibHits = 0; refreshReply = { data: { replaced: true } };
  for (const k of Object.keys(cached)) delete cached[k];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  globalThis.fetch = vi.fn(async (url: any) => { lrclibHits++; return new Response(JSON.stringify(String(url).includes('/api/search') ? [fresh] : fresh)); }) as any;
});
const args = (id: string) => ({ trackId: id, title: 'Test Song', artist: 'Test Artist', duration: 200 });

describe('refreshLyrics', () => {
  it('skips every cache (stored lyrics exist) and searches LRCLIB again', async () => {
    const before = await fetchLyricsCached(args('t1'));
    expect(before.lyrics[0].text).toContain('stale');                    // normal load: stored lyrics
    const r = await refreshLyrics(args('t1'));
    expect(lrclibHits).toBeGreaterThan(0);
    expect(r.lyrics[0].text).toBe('fresh line a');
    expect(r).toMatchObject({ synced: true, lrclibId: 77, shared: 'replaced' });
    expect(invokes.at(-1)).toMatchObject({ action: 'lyrics-refresh', trackId: 't1', lrclibId: 77 });
  });
  it("overwrites this device's cached copy, so the next load uses the new lyrics", async () => {
    await refreshLyrics(args('t2'));
    const key = Object.keys(cached).find(k => k.includes('test song'))!;
    expect(cached[key].meta.lrclibId).toBe(77);
    const next = await fetchLyricsCached(args('t2'));
    expect(next.lyrics[0].text).toBe('fresh line a');
  });
  it('reports each shared-store outcome', async () => {
    refreshReply = { data: { replaced: false, reason: 'same' } };
    expect((await refreshLyrics(args('t3'))).shared).toBe('unchanged');
    refreshReply = { error: { message: 'Unauthorized', context: { status: 401 } } };
    expect((await refreshLyrics(args('t4'))).shared).toBe('device-only');
    refreshReply = { error: { message: 'boom', context: { status: 500 } } };
    expect((await refreshLyrics(args('t5'))).shared).toBe('failed');
  });
  it('without a track id it updates this device only', async () => {
    const r = await refreshLyrics({ title: 'Test Song', artist: 'Test Artist', duration: 200 });
    expect(r.shared).toBe('device-only'); expect(invokes.some(i => i.action === 'lyrics-refresh')).toBe(false);
  });
});
