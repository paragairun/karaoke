// =============================================================================
// CHANGELOG
// =============================================================================
// v1 -- Cached all results including failures (stale empty cache bug).
// v2 -- Never cache failures. Only cache successful results.
// v3 -- CURRENT: Added direct LRCLIB fallback.
//   Root cause of persistent "no lyrics found": the edge function on
//   Supabase may not be deployed or may timeout. The client now falls
//   back to calling LRCLIB directly from the browser if the edge
//   function fails. LRCLIB supports CORS, so no proxy needed.
//   Also added comprehensive console logging for debugging.
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

function cacheKey(args: FetchArgs): string {
  const a = (args.artist || "").toLowerCase().trim();
  const t = (args.title || "").toLowerCase().trim();
  return `lyrics:${a}-${t}`;
}

/** Parse "m:ss" or "h:mm:ss" duration strings into seconds. */
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

// --- LRC parsing (same as edge function) ------------------------------------

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

// --- Direct LRCLIB search (browser -> LRCLIB, no edge function) --------------

async function searchLRCLIBDirect(title: string, artist?: string, duration?: number): Promise<LyricLine[]> {
  const queries: string[] = [];
  if (artist) queries.push(`${title} ${artist}`);
  queries.push(title);
  // First 2-3 words
  const words = title.split(/\s+/);
  if (words.length > 2) queries.push(words.slice(0, 3).join(' '));

  console.log('[Lyrics-Direct] Searching LRCLIB directly with', queries.length, 'queries');

  const results = await Promise.allSettled(
    queries.map(async (q) => {
      const resp = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return [];
      const data: any[] = await resp.json();
      return Array.isArray(data) ? data : [];
    })
  );

  // Collect all results, deduplicate by id
  const seen = new Set<number>();
  const all: any[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (item.id && !seen.has(item.id) && item.syncedLyrics) {
          seen.add(item.id);
          all.push(item);
        }
      }
    }
  }

  console.log('[Lyrics-Direct] Found', all.length, 'synced results from LRCLIB');

  if (all.length === 0) return [];

  // Pick the best match by title similarity
  const titleLower = title.toLowerCase();
  let best: any = null;
  let bestDist = Infinity;
  for (const item of all.slice(0, 25)) {
    const name = (item.trackName || '').toLowerCase();
    // Simple word overlap score (lower = better)
    const qWords = titleLower.split(/\s+/);
    const matched = qWords.filter(w => name.includes(w)).length;
    const dist = qWords.length - matched;
    // Duration penalty
    const durPen = duration && item.duration ? Math.abs(item.duration - duration) * 0.1 : 0;
    const score = dist + durPen;
    if (score < bestDist) {
      bestDist = score;
      best = item;
    }
  }

  if (!best?.syncedLyrics) return [];

  const lyrics = parseLRC(best.syncedLyrics);
  console.log('[Lyrics-Direct] Best match:', best.trackName, 'by', best.artistName, '--', lyrics.length, 'lines');
  return lyrics;
}

// --- Edge function call -----------------------------------------------------

async function invokeEdgeFunction(args: FetchArgs): Promise<LyricLine[]> {
  const body: Record<string, unknown> = { title: args.title };
  if (args.artist) body.artist = args.artist;
  if (args.album) body.album = args.album;
  if (args.duration) body.duration = args.duration;

  console.log('[Lyrics-Edge] Calling fetch-lyrics edge function:', body.title, body.artist || '');

  const { data, error } = await supabase.functions.invoke("fetch-lyrics", { body });

  if (error) {
    console.warn('[Lyrics-Edge] Edge function error:', error.message || error);
    throw error;
  }

  if (data?.lyrics && data.lyrics.length > 0) {
    console.log('[Lyrics-Edge] Found', data.lyrics.length, 'lines from edge function');
    return data.lyrics;
  }

  console.log('[Lyrics-Edge] Edge function returned empty/notFound');
  return [];
}

// --- Main exported function -------------------------------------------------

export async function fetchLyricsCached(args: FetchArgs): Promise<{ lyrics: LyricLine[] }> {
  const key = cacheKey(args);

  // Check cache (only serves successful results)
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached?.lyrics?.length > 0) {
      console.log('[Lyrics] Cache HIT:', cached.lyrics.length, 'lines');
      return cached;
    }
    cache.delete(key); // evict stale empty cache
  }

  // STRATEGY: Try edge function first (has the full search cascade).
  // If it fails or returns empty, fall back to direct LRCLIB search.
  // This ensures lyrics are found even if the edge function isn't deployed.

  let lyrics: LyricLine[] = [];

  // Step 1: Edge function
  try {
    lyrics = await invokeEdgeFunction(args);
  } catch (e) {
    console.warn('[Lyrics] Edge function failed, will try direct LRCLIB:', (e as Error).message);
  }

  // Step 2: Direct LRCLIB fallback (browser -> LRCLIB, no edge function)
  if (lyrics.length === 0) {
    try {
      console.log('[Lyrics] Falling back to direct LRCLIB search');
      lyrics = await searchLRCLIBDirect(args.title, args.artist, args.duration);
    } catch (e) {
      console.warn('[Lyrics] Direct LRCLIB also failed:', (e as Error).message);
    }
  }

  // Cache successful results only
  const result = { lyrics };
  if (lyrics.length > 0) {
    cache.set(key, result);
    console.log('[Lyrics] Cached', lyrics.length, 'lines for:', args.title);
  } else {
    console.log('[Lyrics] No lyrics found anywhere for:', args.title, args.artist || '');
  }

  return result;
}
