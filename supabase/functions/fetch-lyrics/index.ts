// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Sequential 4-attempt cascade (title+artist+album+dur →
//   title+artist+dur → title+artist → title-only), each up to 2.5s timeout.
//   Worst case: 4 sequential timeouts = up to 10s before falling through
//   to the /api/search endpoint. Slow for songs with poor LRCLIB metadata match.
//
// v2 — CURRENT: Parallel cascade + in-memory cache
//   - All 4 get-cached attempts now fire in PARALLEL via Promise.allSettled,
//     not sequentially. Takes the best result instead of stopping at first match —
//     this means we get the MOST SPECIFIC match even if a looser one resolves first.
//   - Added a simple in-memory cache (Map, function-instance-scoped) so repeat
//     lookups for the same song within the same warm instance return instantly.
//     Edge functions on Supabase stay warm for several minutes between
//     invocations, so this catches the very common case of multiple users
//     singing the same popular song.
//   - Reduced per-attempt timeout from 2.5s to 1.8s since parallel attempts
//     no longer compound — even 4x1.8s in parallel finishes in ~1.8s total.
// =============================================================================

// supabase/functions/fetch-lyrics/index.ts
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_TITLE_LENGTH = 200;
const MAX_ARTIST_LENGTH = 200;
const MAX_DURATION = 3600;
const LRCLIB_TIMEOUT_MS = 1800; // per get-cached attempt — parallel now, can be tighter

// Simple in-memory cache, scoped to this warm function instance.
// Supabase edge functions stay warm for several minutes between calls,
// so this catches repeat searches for the same popular song without
// re-hitting LRCLIB at all.
const lyricsCache = new Map<string, { result: LyricsResponse | null; ts: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cacheKey(title: string, artist: string, album?: string, duration?: number) {
  return `${title.toLowerCase()}|${artist.toLowerCase()}|${album?.toLowerCase() ?? ''}|${duration ?? ''}`;
}

interface LyricLine { time: number; text: string; duration?: number; }
interface LyricsResult {
  id: number; trackName: string; artistName: string;
  albumName?: string; duration?: number; lyrics: LyricLine[]; synced: boolean;
}
interface LyricsResponse { lyrics: LyricLine[]; source: string; synced: boolean; }
interface SearchResultsResponse { results: LyricsResult[]; source: string; }

function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const line of lrc.split('\n')) {
    const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
    if (match) {
      const time = parseInt(match[1]) * 60 + parseInt(match[2]) + (match[3] ? parseInt(match[3].padEnd(3, '0')) : 0) / 1000;
      const text = match[4].trim();
      if (text) lines.push({ time, text });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    lines[i].duration = i < lines.length - 1 ? lines[i + 1].time - lines[i].time : 5;
  }
  return lines.sort((a, b) => a.time - b.time);
}

function convertPlainLyrics(plain: string): LyricLine[] {
  return plain.split('\n').filter(l => l.trim()).map((text, i) => ({
    time: i * 4, text: text.trim(), duration: 4,
  }));
}

function timedFetch(url: string, ms = LRCLIB_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function parseLRCLIBResult(data: any, fallbackTitle: string, fallbackArtist: string): LyricLine[] | null {
  if (data.syncedLyrics) return parseLRC(data.syncedLyrics);
  if (data.plainLyrics) return convertPlainLyrics(data.plainLyrics);
  return null;
}

/**
 * Try LRCLIB get-cached with progressively looser parameters.
 * Strategy (most specific → least specific):
 *   1. title + artist + album + duration
 *   2. title + artist + duration
 *   3. title + artist
 *   4. title only
 * Returns first successful match or null.
 */
async function searchLRCLIBCascade(
  title: string,
  artist: string,
  album?: string,
  duration?: number,
): Promise<LyricsResponse | null> {
  const key = cacheKey(title, artist, album, duration);
  const cached = lyricsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log('Lyrics cache HIT:', key);
    return cached.result;
  }

  // Build all attempts (most specific → least specific), tagged with a
  // specificity rank so we can pick the BEST result even though they all
  // run in parallel and may resolve in any order.
  type Attempt = { params: URLSearchParams; rank: number };
  const attempts: Attempt[] = [];

  if (artist && album && duration) {
    attempts.push({
      rank: 4,
      params: new URLSearchParams({ track_name: title, artist_name: artist, album_name: album, duration: String(Math.round(duration)) }),
    });
  }
  if (artist && duration) {
    attempts.push({
      rank: 3,
      params: new URLSearchParams({ track_name: title, artist_name: artist, duration: String(Math.round(duration)) }),
    });
  }
  if (artist) {
    attempts.push({ rank: 2, params: new URLSearchParams({ track_name: title, artist_name: artist }) });
  }
  attempts.push({ rank: 1, params: new URLSearchParams({ track_name: title }) });

  // Deduplicate by query string
  const seen = new Set<string>();
  const unique = attempts.filter(a => {
    const k = a.params.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // OPTIMIZATION: fire all attempts in PARALLEL instead of sequentially.
  // Previously each attempt waited for the prior one to time out before
  // trying the next — worst case 4x timeout (up to 10s).
  // Now all 4 race together; total wall time ≈ slowest single attempt (~1.8s).
  const settled = await Promise.allSettled(
    unique.map(async (a) => {
      console.log('LRCLIB get-cached attempt (parallel):', a.params.toString());
      const resp = await timedFetch(`https://lrclib.net/api/get-cached?${a.params}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const lyrics = parseLRCLIBResult(data, title, artist);
      if (!lyrics || lyrics.length === 0) return null;
      return { rank: a.rank, lyrics, synced: !!data.syncedLyrics, params: a.params.toString() };
    })
  );

  // Pick the highest-rank (most specific) successful result, not just the
  // first to resolve — a looser query can resolve faster but be less accurate.
  const successes = settled
    .filter((s): s is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof fetch>>> | any> => s.status === 'fulfilled' && s.value !== null)
    .map(s => (s as PromiseFulfilledResult<any>).value)
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank);

  if (successes.length > 0) {
    const best = successes[0];
    console.log('LRCLIB best hit:', best.params, '→', best.lyrics.length, 'lines, synced:', best.synced);
    const result: LyricsResponse = { lyrics: best.lyrics, source: 'lrclib', synced: best.synced };
    lyricsCache.set(key, { result, ts: Date.now() });
    return result;
  }

  // 5. If all get-cached attempts fail, try the /api/search endpoint (slower but broader)
  try {
    console.log('LRCLIB falling back to /api/search');
    const sp = new URLSearchParams({ track_name: title });
    if (artist) sp.set('artist_name', artist);
    const resp = await timedFetch(`https://lrclib.net/api/search?${sp}`, 5000);
    if (resp.ok) {
      const results: any[] = await resp.json();
      if (Array.isArray(results) && results.length > 0) {
        // Prefer synced, then by duration match
        const sorted = [...results].sort((a, b) => {
          const aSync = !!a.syncedLyrics, bSync = !!b.syncedLyrics;
          if (aSync && !bSync) return -1;
          if (!aSync && bSync) return 1;
          // Prefer duration-matching if we have it
          if (duration) {
            const aDiff = Math.abs((a.duration ?? 0) - duration);
            const bDiff = Math.abs((b.duration ?? 0) - duration);
            return aDiff - bDiff;
          }
          return 0;
        });
        for (const r of sorted.slice(0, 3)) {
          const lyrics = parseLRCLIBResult(r, title, artist);
          if (lyrics && lyrics.length > 0) {
            console.log('LRCLIB search hit:', r.trackName, 'by', r.artistName, '→', lyrics.length, 'lines');
            return { lyrics, source: 'lrclib-search', synced: !!r.syncedLyrics };
          }
        }
      }
    }
  } catch (e) {
    console.warn('LRCLIB search fallback failed:', (e as Error).message);
  }

  // Cache the miss too (shorter effective benefit, but prevents repeat
  // hammering of LRCLIB for songs with genuinely no match for a while)
  lyricsCache.set(key, { result: null, ts: Date.now() });
  return null;
}

/** Return top 3 results for user selection (searchMultiple=true). */
async function searchLRCLIBMultiple(title: string, artist: string): Promise<LyricsResult[]> {
  try {
    const sp = new URLSearchParams({ track_name: title });
    if (artist) sp.set('artist_name', artist);
    const resp = await timedFetch(`https://lrclib.net/api/search?${sp}`, 5000);
    if (!resp.ok) return [];
    const results: any[] = await resp.json();
    if (!Array.isArray(results) || results.length === 0) return [];

    return results
      .sort((a, b) => (!!b.syncedLyrics ? 1 : 0) - (!!a.syncedLyrics ? 1 : 0))
      .slice(0, 5)
      .map(r => {
        const lyrics = parseLRCLIBResult(r, title, artist);
        return lyrics && lyrics.length > 0 ? {
          id: r.id,
          trackName: r.trackName || title,
          artistName: r.artistName || artist,
          albumName: r.albumName,
          duration: r.duration,
          lyrics,
          synced: !!r.syncedLyrics,
        } : null;
      })
      .filter(Boolean) as LyricsResult[];
  } catch (e) {
    console.error('LRCLIB multiple search error:', e);
    return [];
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { title, artist, album, duration, searchMultiple = false } = body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return new Response(JSON.stringify({ error: 'Title is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const trimmedTitle = title.trim().slice(0, MAX_TITLE_LENGTH);
    const trimmedArtist = typeof artist === 'string' ? artist.trim().slice(0, MAX_ARTIST_LENGTH) : '';
    const trimmedAlbum = typeof album === 'string' ? album.trim().slice(0, MAX_TITLE_LENGTH) : undefined;
    const validDuration = typeof duration === 'number' && isFinite(duration) && duration > 0 && duration <= MAX_DURATION
      ? Math.floor(duration) : undefined;

    console.log('fetch-lyrics:', trimmedTitle, '|', trimmedArtist, '| searchMultiple:', searchMultiple);

    if (searchMultiple) {
      const results = await searchLRCLIBMultiple(trimmedTitle, trimmedArtist);
      console.log(`Found ${results.length} results`);
      return new Response(JSON.stringify({ results, source: 'lrclib' } as SearchResultsResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Single fetch: cascade from most specific to title-only
    const lyricsResult = await searchLRCLIBCascade(trimmedTitle, trimmedArtist, trimmedAlbum, validDuration);

    if (lyricsResult) {
      console.log(`Returning ${lyricsResult.lyrics.length} lines, synced: ${lyricsResult.synced}`);
      return new Response(JSON.stringify(lyricsResult),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log('No lyrics found for:', trimmedTitle);
    return new Response(
      JSON.stringify({ lyrics: [], source: 'lrclib', synced: false, notFound: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Lyrics fetch error:', msg);
    return new Response(JSON.stringify({ error: 'Failed to fetch lyrics', details: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
