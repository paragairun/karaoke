// =============================================================================
// CHANGELOG
// v1 -- Cached all results including failures (stale empty cache bug).
// v2 -- Never cache failures. Only cache successful results.
// v3 -- Added direct LRCLIB fallback + accepts plain lyrics.
//   Root cause of "no lyrics found": edge function returned empty AND
//   direct LRCLIB search filtered out plain-only results. Many Hindi
//   songs on LRCLIB have plainLyrics but not syncedLyrics. Now accepts
//   plain lyrics with auto-generated timing as a fallback.
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

// --- Direct LRCLIB search (browser -> LRCLIB, no edge function) ---

async function searchLRCLIBDirect(title: string, artist?: string, duration?: number): Promise<LyricLine[]> {
  // Hindi romanization varies between Saavn and LRCLIB (e.g. "Sapnon" vs "Sapno",
  // "Duniyaa" vs "Duniya"). Generate a trimmed variant where each word > 4 chars
  // loses its last character. This single fix handles most Hindi spelling differences.
  const words = title.split(/\s+/);
  const trimmedWords = words.map(w => w.length > 4 ? w.slice(0, -1) : w);
  const trimmedTitle = trimmedWords.join(' ');

  const queries: string[] = [];
  if (artist) queries.push(`${title} ${artist}`);
  queries.push(title);
  // Trimmed variant (critical for Hindi: "Sapnon" -> "Sapno")
  if (trimmedTitle !== title) queries.push(trimmedTitle);
  if (words.length > 2) queries.push(words.slice(0, 3).join(' '));
  // Trimmed first 3 words
  if (words.length > 2) {
    const t3 = trimmedWords.slice(0, 3).join(' ');
    if (t3 !== words.slice(0, 3).join(' ')) queries.push(t3);
  }
  if (words.length > 3) queries.push(words.slice(0, 2).join(' '));

  console.log('[Lyrics-Direct] Searching LRCLIB with', queries.length, 'queries:', queries);

  // LRCLIB asks API consumers to identify themselves via Lrclib-Client header.
  // Without it, some requests may be rate-limited or rejected.
  const headers: Record<string, string> = {
    'Lrclib-Client': 'KaraokeParty (https://karaokeparty.in)',
  };

  const results = await Promise.allSettled(
    queries.map(async (q) => {
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
      console.log('[Lyrics-Direct] Fetching:', url);
      try {
        // NO timeout -- the FLAC download from Modal saturates the connection
        // for 10-30s. LRCLIB requests queue behind it and complete once
        // bandwidth frees up. A timeout would kill them prematurely.
        const resp = await fetch(url, { headers });
        console.log('[Lyrics-Direct] Response for q="' + q + '":', resp.status, resp.statusText);
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          console.warn('[Lyrics-Direct] Non-OK response body:', body.slice(0, 200));
          return [];
        }
        const text = await resp.text();
        let data: any[];
        try {
          data = JSON.parse(text);
        } catch (parseErr) {
          console.error('[Lyrics-Direct] JSON parse failed. Raw body:', text.slice(0, 300));
          return [];
        }
        if (!Array.isArray(data)) {
          console.warn('[Lyrics-Direct] Response is not an array:', typeof data);
          return [];
        }
        console.log('[Lyrics-Direct] Got', data.length, 'results for q="' + q + '"',
          '| synced:', data.filter((d: any) => d.syncedLyrics).length,
          '| plain:', data.filter((d: any) => d.plainLyrics && !d.syncedLyrics).length);
        return data;
      } catch (fetchErr: any) {
        console.error('[Lyrics-Direct] Fetch error for q="' + q + '":', fetchErr?.message || fetchErr);
        return [];
      }
    })
  );

  // Collect results, preferring synced, accepting plain as fallback
  const seen = new Set<number>();
  const synced: any[] = [];
  const plain: any[] = [];

  for (const r of results) {
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

  console.log('[Lyrics-Direct] Results:', synced.length, 'synced,', plain.length, 'plain-only');

  // Pick best from synced first, then plain
  const pool = synced.length > 0 ? synced : plain;
  if (pool.length === 0) return [];

  // Rank by title word overlap (lower distance = better)
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

// --- Edge function call ---

async function callEdgeFunction(args: FetchArgs): Promise<LyricLine[]> {
  const body: Record<string, unknown> = { title: args.title };
  if (args.artist) body.artist = args.artist;
  if (args.album) body.album = args.album;
  if (args.duration) body.duration = args.duration;

  console.log('[Lyrics-Edge] Calling edge function:', args.title, args.artist || '');

  const { data, error } = await supabase.functions.invoke("fetch-lyrics", { body });

  if (error) {
    console.warn('[Lyrics-Edge] Error:', error.message || error);
    throw error;
  }

  if (data?.lyrics && data.lyrics.length > 0) {
    console.log('[Lyrics-Edge] Found', data.lyrics.length, 'lines');
    return data.lyrics;
  }

  console.log('[Lyrics-Edge] Empty result. notFound:', data?.notFound, 'source:', data?.source);
  return [];
}

// --- Main export ---

export async function fetchLyricsCached(args: FetchArgs): Promise<{ lyrics: LyricLine[] }> {
  const key = cacheKey(args);

  // Serve from cache only if lyrics exist
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached?.lyrics?.length > 0) {
      console.log('[Lyrics] Cache HIT:', cached.lyrics.length, 'lines');
      return cached;
    }
    cache.delete(key);
  }

  let lyrics: LyricLine[] = [];

  // Step 1: Edge function (has full LRCLIB search cascade)
  try {
    lyrics = await callEdgeFunction(args);
  } catch (e) {
    console.warn('[Lyrics] Edge function failed:', (e as Error).message);
  }

  // Step 2: Direct LRCLIB from browser (bypasses edge function entirely)
  if (lyrics.length === 0) {
    try {
      console.log('[Lyrics] Edge returned nothing. Trying direct LRCLIB...');
      lyrics = await searchLRCLIBDirect(args.title, args.artist, args.duration);
    } catch (e) {
      console.warn('[Lyrics] Direct LRCLIB failed:', (e as Error).message);
    }
  }

  const result = { lyrics };
  if (lyrics.length > 0) {
    cache.set(key, result);
    console.log('[Lyrics] SUCCESS:', lyrics.length, 'lines for', args.title);
  } else {
    console.log('[Lyrics] FAILED: No lyrics found for', args.title, args.artist || '');
  }

  return result;
}
