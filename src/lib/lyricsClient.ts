// =============================================================================
// CHANGELOG
// v1 -- Cached all results including failures.
// v2 -- Never cache failures.
// v3 -- Direct LRCLIB fallback + plain lyrics.
// v4 -- CURRENT: Skip edge function (returns empty, wastes 30s).
//   Go straight to direct LRCLIB search from browser.
//   In-flight deduplication prevents Index.tsx + Sing.tsx double fetch.
//   Queries run in batches of 2 to avoid saturating the connection.
// =============================================================================

import { supabase } from "@/integrations/supabase/client";

export interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

interface FetchArgs {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}

const cache = new Map<string, any>();
const inFlight = new Map<string, Promise<{ lyrics: LyricLine[] }>>();

function cacheKey(args: FetchArgs): string {
  return `lyrics:${(args.artist || "").toLowerCase().trim()}-${(args.title || "").toLowerCase().trim()}`;
}

export function parseDurationToSeconds(value?: string | number): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== "string") return undefined;
  const parts = value.split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return undefined;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs > 0 ? secs : undefined;
}

// --- LRC parsing ---

function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const line of lrc.split('\n')) {
    const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
    if (match) {
      const time = parseInt(match[1]) * 60 + parseInt(match[2])
        + (match[3] ? parseInt(match[3].padEnd(3, '0')) : 0) / 1000;
      const text = match[4].trim();
      if (text) lines.push({ time, text });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    lines[i].duration = i < lines.length - 1 ? lines[i+1].time - lines[i].time : 5;
  }
  return lines.sort((a, b) => a.time - b.time);
}

function plainToLyricLines(plain: string): LyricLine[] {
  return plain
    .split('\n')
    .filter(l => l.trim())
    .map((text, i) => ({ time: i * 4, text: text.trim(), duration: 4 }));
}



// --- Direct LRCLIB search ---

const LRCLIB_HEADERS = { 'Lrclib-Client': 'KaraokeParty (https://karaokeparty.in)' };

async function searchLRCLIBDirect(title: string, artist?: string, album?: string, duration?: number): Promise<LyricLine[]> {
  const words = title.split(/\s+/);
  const trimmedWords = words.map(w => w.length > 4 ? w.slice(0, -1) : w);
  const trimmedTitle = trimmedWords.join(' ');

  // -- Step 1: Try /api/get (exact metadata match -- fastest) ----------
  // Uses title + artist + album + duration for precise lookup.
  // Returns a single result, no ranking needed.
  // No artist_name -- inconsistent between JioSaavn and LRCLIB.
  // track_name + album_name + duration is enough for a precise match.
  const getAttempts: string[] = [];
  const getParams = new URLSearchParams();
  getParams.set('track_name', title);
  if (album) getParams.set('album_name', album);
  if (duration) getParams.set('duration', String(duration));
  getAttempts.push(getParams.toString());

  // Try without album (LRCLIB might store under a different album name)
  if (album) {
    const p2 = new URLSearchParams();
    p2.set('track_name', title);
    if (duration) p2.set('duration', String(duration));
    getAttempts.push(p2.toString());
  }

  // Try trimmed title (Hindi romanization variant)
  if (trimmedTitle !== title) {
    const p3 = new URLSearchParams();
    p3.set('track_name', trimmedTitle);
    if (duration) p3.set('duration', String(duration));
    getAttempts.push(p3.toString());
  }

  console.log('[Lyrics-Direct] Step 1: Trying /api/get with', getAttempts.length, 'param sets');

  for (const params of getAttempts) {
    try {
      const url = `https://lrclib.net/api/get?${params}`;
      const resp = await fetch(url, { headers: LRCLIB_HEADERS });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.syncedLyrics) {
          const lyrics = parseLRC(data.syncedLyrics);
          console.log('[Lyrics-Direct] /api/get HIT (synced):', data.trackName, 'by', data.artistName, '-', lyrics.length, 'lines');
          return lyrics;
        }
        if (data?.plainLyrics) {
          const lyrics = plainToLyricLines(data.plainLyrics);
          console.log('[Lyrics-Direct] /api/get HIT (plain):', data.trackName, 'by', data.artistName, '-', lyrics.length, 'lines');
          return lyrics;
        }
      }
    } catch (e) {
      // /api/get returns 404 when not found -- that's expected, continue
    }
  }
  console.log('[Lyrics-Direct] /api/get found nothing, falling back to /api/search');

  // -- Step 2: Fall back to /api/search (free-text, batched) ----------
  // Build query list -- ordered from most specific to broadest.
  // Batches of 2, early exit when synced lyrics found.
  const queries: string[] = [];
  // Batch 1: full title + artist, full title
  if (artist) queries.push(`${title} ${artist}`);
  queries.push(title);
  // Batch 2: trimmed title (Hindi variants), first 3 words
  if (trimmedTitle !== title) queries.push(trimmedTitle);
  if (words.length > 3) queries.push(words.slice(0, 3).join(' '));
  // Batch 3: first 2 words, trimmed first 3 words
  if (words.length > 2) queries.push(words.slice(0, 2).join(' '));
  if (words.length > 3) {
    const t3 = trimmedWords.slice(0, 3).join(' ');
    if (t3 !== words.slice(0, 3).join(' ')) queries.push(t3);
  }

  console.log('[Lyrics-Direct] Searching LRCLIB with', queries.length, 'queries:', queries);

  const fetchFns = queries.map(q => async () => {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
    console.log('[Lyrics-Direct] Fetching:', url);
    const resp = await fetch(url, { headers: LRCLIB_HEADERS });
    console.log('[Lyrics-Direct] Response for q="' + q + '":', resp.status, resp.statusText);
    if (!resp.ok) return [];
    const text = await resp.text();
    let data: any[];
    try { data = JSON.parse(text); } catch { return []; }
    if (!Array.isArray(data)) return [];
    console.log('[Lyrics-Direct] Got', data.length, 'results for q="' + q + '"',
      '| synced:', data.filter((d: any) => d.syncedLyrics).length,
      '| plain:', data.filter((d: any) => d.plainLyrics && !d.syncedLyrics).length);
    return data;
  });

  // Run 2 at a time. Stop as soon as any batch finds synced lyrics.
  const seen = new Set<number>();
  const synced: any[] = [];
  const plain: any[] = [];

  for (let i = 0; i < fetchFns.length; i += 2) {
    const batch = fetchFns.slice(i, i + 2);
    const settled = await Promise.allSettled(batch.map(fn => fn()));

    for (const r of settled) {
      if (r.status === 'rejected') {
        console.warn('[Lyrics-Direct] Query rejected:', r.reason?.message || 'unknown');
        continue;
      }
      for (const item of r.value) {
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        if (item.syncedLyrics) synced.push(item);
        else if (item.plainLyrics) plain.push(item);
      }
    }

    if (synced.length > 0) {
      console.log('[Lyrics-Direct] Found', synced.length, 'synced in batch', Math.floor(i/2)+1, '-- skipping remaining batches');
      break;
    }
  }

  console.log('[Lyrics-Direct] Results:', synced.length, 'synced,', plain.length, 'plain-only');

  const pool = synced.length > 0 ? synced : plain;
  if (pool.length === 0) return [];

  const titleLower = title.toLowerCase();
  const titleWords = titleLower.split(/\s+/);
  let best: any = null;
  let bestScore = Infinity;

  for (const item of pool.slice(0, 25)) {
    const name = (item.trackName || '').toLowerCase();
    const matched = titleWords.filter(w => name.includes(w)).length;
    const dist = titleWords.length - matched;
    const durPen = duration && item.duration ? Math.abs(item.duration - duration) * 0.05 : 0;
    const s = dist + durPen;
    if (s < bestScore) { bestScore = s; best = item; }
  }

  if (!best) return [];

  if (best.syncedLyrics) {
    const lyrics = parseLRC(best.syncedLyrics);
    console.log('[Lyrics-Direct] Using SYNCED:', best.trackName, 'by', best.artistName, '-', lyrics.length, 'lines');
    return lyrics;
  }
  if (best.plainLyrics) {
    const lyrics = plainToLyricLines(best.plainLyrics);
    console.log('[Lyrics-Direct] Using PLAIN (auto-timed):', best.trackName, 'by', best.artistName, '-', lyrics.length, 'lines');
    return lyrics;
  }
  return [];
}

// --- Main export ---

export async function fetchLyricsCached(args: FetchArgs): Promise<{ lyrics: LyricLine[] }> {
  const key = cacheKey(args);

  // Serve from cache
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached?.lyrics?.length > 0) {
      console.log('[Lyrics] Cache HIT:', cached.lyrics.length, 'lines');
      return cached;
    }
    cache.delete(key);
  }

  // Deduplicate in-flight requests (Index.tsx + Sing.tsx call simultaneously)
  if (inFlight.has(key)) {
    console.log('[Lyrics] Joining in-flight request for:', args.title);
    return inFlight.get(key)!;
  }

  const promise = (async (): Promise<{ lyrics: LyricLine[] }> => {
    let lyrics: LyricLine[] = [];

    // Go straight to direct LRCLIB (edge function returns empty, wastes 30s)
    try {
      lyrics = await searchLRCLIBDirect(args.title, args.artist, args.album, args.duration);
    } catch (e) {
      console.warn('[Lyrics] Direct LRCLIB failed:', (e as Error).message);
    }

    const result = { lyrics };
    if (lyrics.length > 0) {
      cache.set(key, result);
      console.log('[Lyrics] SUCCESS:', lyrics.length, 'lines for', args.title);
    } else {
      console.log('[Lyrics] FAILED: No lyrics found for', args.title, args.artist || '');
    }
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
