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
  language?: string; // "hindi", "punjabi", "english", etc. from Saavn
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

// -- Script detection ---------------------------------------------------
// Detects the dominant script of a lyrics block. Used to prefer Devanagari
// results for Hindi songs -- LRCLIB stores the same song under multiple
// scripts (Devanagari, romanized Latin, occasionally Gurmukhi/Punjabi if a
// contributor mislabels it), and Devanagari is what most Hindi-speaking
// users expect to read while singing.
type Script = 'devanagari' | 'latin' | 'gurmukhi' | 'dual' | 'unknown';

function detectScript(text: string): Script {
  let deva = 0, latin = 0, gurmukhi = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0900 && code <= 0x097F) deva++;
    else if (code >= 0x0A00 && code <= 0x0A7F) gurmukhi++;
    else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latin++;
  }
  const total = deva + latin + gurmukhi;
  if (total === 0) return 'unknown';
  const devaPct = deva / total;
  const latinPct = latin / total;
  const guruPct = gurmukhi / total;
  // Mixed script (e.g. Hindi verse + English chorus) -- more than one
  // script each representing a meaningful share of the text.
  const significant = [devaPct, latinPct, guruPct].filter(p => p > 0.15).length;
  if (significant >= 2) return 'dual';
  if (devaPct > latinPct && devaPct > guruPct) return 'devanagari';
  if (guruPct > latinPct && guruPct > devaPct) return 'gurmukhi';
  if (latinPct > 0) return 'latin';
  return 'unknown';
}

// Scoring penalty applied per script, only when the song's Saavn language
// is Hindi. Lower is better (this is subtracted... actually added to a
// "lower is better" distance score, so it works like a penalty).
function scriptPenalty(script: Script, language?: string): number {
  const isHindi = (language || '').toLowerCase() === 'hindi';
  if (!isHindi) return 0; // no script bias for non-Hindi songs
  switch (script) {
    case 'devanagari': return 0;      // preferred
    case 'latin': return 0;           // equally acceptable -- romanized lyrics are fine
    case 'unknown': return 3;         // usually short/ambiguous text, slight caution
    case 'gurmukhi': return 10;       // wrong script for Hindi audience -- moderate, same as dual
    case 'dual': return 10;           // mixed script, distracting while singing
  }
}



// --- Direct LRCLIB search ---

const LRCLIB_HEADERS = { 'Lrclib-Client': 'KaraokeParty (https://karaokeparty.in)' };

async function searchLRCLIBDirect(title: string, artist?: string, album?: string, duration?: number, language?: string): Promise<LyricLine[]> {
  const words = title.split(/\s+/);
  const trimmedWords = words.map(w => w.length > 4 ? w.slice(0, -1) : w);
  const trimmedTitle = trimmedWords.join(' ');

  // -- Step 1: Try /api/get (exact metadata match -- fastest) ----------
  // Uses title + artist + album + duration for precise lookup.
  // Returns a single result, no ranking needed.
  // artist_name is REQUIRED by /api/get (400 without it).
  // Try up to 3 artists (Saavn often lists multiple for duets/collabs).
  // For each artist, progressively drop album/duration to broaden the match.
  // LRCLIB might store the song under any of the credited artists.
  const artists = (artist || '')
    .split(/[,&]/)
    .map(a => a.trim())
    .filter(a => a.length > 0)
    .slice(0, 3); // max 3 artists

  const getAttempts: string[] = [];
  const seen = new Set<string>();

  for (const art of artists) {
    const combos: [boolean, boolean][] = [
      [true, true],   // album + duration (most specific)
      [false, true],  // duration only
      [true, false],  // album only
      [false, false], // broadest
    ];
    for (const [useAlbum, useDur] of combos) {
      if (useAlbum && !album) continue;
      if (useDur && !duration) continue;
      const p = new URLSearchParams();
      p.set('track_name', title);
      p.set('artist_name', art);
      if (useAlbum) p.set('album_name', album!);
      if (useDur) p.set('duration', String(duration));
      const key = p.toString();
      if (!seen.has(key)) { seen.add(key); getAttempts.push(key); }
    }
  }

  console.log('[Lyrics-Direct] Step 1: Trying /api/get with', getAttempts.length, 'param sets');

  // Collect every /api/get hit rather than returning on the first one.
  // For Hindi songs, LRCLIB may have both a Devanagari and a Latin/Gurmukhi
  // entry matching the same params -- we want the Devanagari version.
  // If the very first hit is already Devanagari (or language isn't Hindi),
  // stop early -- no need to burn through all 12 attempts.
  const getHits: { lyrics: LyricLine[]; script: Script; trackName: string; artistName: string }[] = [];

  for (const params of getAttempts) {
    try {
      const url = `https://lrclib.net/api/get?${params}`;
      const resp = await fetch(url, { headers: LRCLIB_HEADERS });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.syncedLyrics) {
          const script = detectScript(data.syncedLyrics);
          const lyrics = parseLRC(data.syncedLyrics);
          console.log('[Lyrics-Direct] /api/get HIT (synced,', script + '):', data.trackName, 'by', data.artistName, '-', lyrics.length, 'lines');
          getHits.push({ lyrics, script, trackName: data.trackName, artistName: data.artistName });
          if (scriptPenalty(script, language) === 0) break; // already ideal script, stop searching
        } else if (data?.plainLyrics) {
          const script = detectScript(data.plainLyrics);
          const lyrics = plainToLyricLines(data.plainLyrics);
          console.log('[Lyrics-Direct] /api/get HIT (plain,', script + '):', data.trackName, 'by', data.artistName, '-', lyrics.length, 'lines');
          getHits.push({ lyrics, script, trackName: data.trackName, artistName: data.artistName });
          if (scriptPenalty(script, language) === 0) break;
        }
      }
    } catch (e) {
      // /api/get returns 404 when not found -- that's expected, continue
    }
  }

  if (getHits.length > 0) {
    getHits.sort((a, b) => scriptPenalty(a.script, language) - scriptPenalty(b.script, language));
    const best = getHits[0];
    console.log('[Lyrics-Direct] /api/get best pick:', best.trackName, 'by', best.artistName, '(' + best.script + ')');
    return best.lyrics;
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
  const seenIds = new Set<number>();
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
        if (!item.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
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
  let bestScript: Script = 'unknown';
  let bestScore = Infinity;

  for (const item of pool.slice(0, 25)) {
    const name = (item.trackName || '').toLowerCase();
    const matched = titleWords.filter(w => name.includes(w)).length;
    const dist = titleWords.length - matched;
    const durPen = duration && item.duration ? Math.abs(item.duration - duration) * 0.05 : 0;
    const lyricsText = item.syncedLyrics || item.plainLyrics || '';
    const script = detectScript(lyricsText);
    const scriptPen = scriptPenalty(script, language);
    const s = dist + durPen + scriptPen;
    if (s < bestScore) { bestScore = s; best = item; bestScript = script; }
  }

  if (!best) return [];

  if (best.syncedLyrics) {
    const lyrics = parseLRC(best.syncedLyrics);
    console.log('[Lyrics-Direct] Using SYNCED (' + bestScript + '):', best.trackName, 'by', best.artistName, '-', lyrics.length, 'lines');
    return lyrics;
  }
  if (best.plainLyrics) {
    const lyrics = plainToLyricLines(best.plainLyrics);
    console.log('[Lyrics-Direct] Using PLAIN (auto-timed,', bestScript + '):', best.trackName, 'by', best.artistName, '-', lyrics.length, 'lines');
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
      lyrics = await searchLRCLIBDirect(args.title, args.artist, args.album, args.duration, args.language);
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
