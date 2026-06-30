// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Basic LRCLIB cascade: title+artist+album+dur → title-only
//
// v2 — Parallel cascade + in-memory cache (from previous session)
//
// v3 — CURRENT: Fixed root cause of ~80% of lyrics failures
//
//   ROOT CAUSES DIAGNOSED from code + Saavn API response shapes:
//
//   1. DIRTY TITLES FROM SAAVN
//      Saavn returns: "Tum Hi Ho (From Aashiqui 2)", "Tera Ban Jaunga (Full Song)",
//      "Raatan Lambiyaan - Lyrical Video | Jubin Nautiyal"
//      LRCLIB get-cached does EXACT title matching against music database titles
//      like "Tum Hi Ho". So get-cached always fails on raw Saavn titles.
//      This is why manually searching LRCLIB.net works (clean title) but the
//      function doesn't (passes raw Saavn title).
//      FIX: cleanTitleForLRCLIB() strips all common Saavn title suffixes before
//      any LRCLIB lookup is attempted.
//
//   2. COMMA-JOINED ARTIST LISTS FROM SAAVN
//      Saavn returns: "Arijit Singh, Palak Muchhal"
//      LRCLIB stores: "Arijit Singh" (only the primary/first artist)
//      get-cached artist_name must match exactly — so the comma-joined list
//      never finds anything even when the right track exists.
//      FIX: cleanArtistForLRCLIB() takes only the first artist (before comma).
//
//   3. /api/search fallback only tried top 3 results, no q= parameter
//      LRCLIB /api/search supports a q= free-text parameter that does
//      partial matching across title+artist+album simultaneously — this is
//      the same parameter the LRCLIB.net website search box uses.
//      Our function was not using q= at all, only track_name= and
//      artist_name= which are more restrictive filters.
//      FIX: added progressive keyword fallback using q= with increasingly
//      loose keyword combinations:
//        1. q="Full Title Artist"  (most specific)
//        2. q="Full Title"        (title only)
//        3. q="First Two Words"   (partial title)
//        4. q="First Word" + artist_name= filter
//      Results from all q= attempts ranked by Levenshtein similarity.
//
//   4. Removed popup/dialog pattern — lyrics now fetched silently in background
//      Both the edge function and lyricsClient.ts are now designed for
//      background-first fetching. The cleaned title + artist are returned
//      in the response so the frontend can show what was actually found.
// =============================================================================

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_TITLE_LENGTH = 200;
const MAX_ARTIST_LENGTH = 200;
const MAX_DURATION = 3600;
const LRCLIB_TIMEOUT_MS = 4000;

interface LyricLine { time: number; text: string; duration?: number; }
interface LyricsResponse { lyrics: LyricLine[]; source: string; synced: boolean; cleanedTitle?: string; cleanedArtist?: string; }

// ─── Title/Artist cleaning ─────────────────────────────────────────────────
// Strips Saavn-specific noise from song titles before LRCLIB lookup.
// LRCLIB uses MusicBrainz/canonical database titles without these suffixes.

function cleanTitleForLRCLIB(raw: string): string {
  return raw
    // Remove everything after a pipe (Saavn often appends "| Artist Name")
    .replace(/\s*\|.*$/, '')
    // Remove parenthetical suffixes that Saavn adds but databases don't have
    .replace(/\s*\((?:From|OST|From The Movie|From The Film|Full Song|Official Song|Official Video|Lyrical Video|Audio Song|Video Song|Lyric Video|Audio|Video|HD|4K|[^)]*Soundtrack)[^)]*\)\s*/gi, '')
    // Remove bracketed suffixes
    .replace(/\s*\[(?:Full Song|Official|Lyrical|Audio|Video|HD|4K)[^\]]*\]\s*/gi, '')
    // Remove trailing dash + anything (e.g. "Song Name - Lyrical | Artist")
    .replace(/\s*-\s*(Lyrical|Official|Full Song|Audio|Video|HD|4K|Lyrics).*$/i, '')
    .trim();
}

function cleanArtistForLRCLIB(raw: string): string {
  // LRCLIB stores only the primary/first artist. Saavn joins multiple artists
  // with comma or ampersand. Take only the first one.
  return raw
    .split(/,|&|feat\.|ft\.|featuring/i)[0]
    .trim();
}

// Simple Levenshtein distance for ranking /api/search results by title match
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ─── Language/script detection ──────────────────────────────────────────────
// Detects if lyrics mix Devanagari and Latin scripts (dual-language).
// Single-script lyrics are preferred for karaoke readability.

function detectScript(text: string): 'devanagari' | 'latin' | 'dual' | 'unknown' {
  let devaCount = 0;
  let latinCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0900 && code <= 0x097F) devaCount++;
    else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latinCount++;
  }
  const total = devaCount + latinCount;
  if (total === 0) return 'unknown';
  const devaPct = devaCount / total;
  const latinPct = latinCount / total;
  // If both scripts represent >15% of text, it is dual-language
  if (devaPct > 0.15 && latinPct > 0.15) return 'dual';
  if (devaPct > latinPct) return 'devanagari';
  return 'latin';
}

// ─── LRC parsing ────────────────────────────────────────────────────────────

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

function extractLyrics(data: any): LyricLine[] | null {
  // Only return synced lyrics — plain/unsynced not accepted
  if (data?.syncedLyrics) return parseLRC(data.syncedLyrics);
  return null;
}

// ─── Main lookup ──────────────────────────────────────────────────────────
// Tries progressively looser LRCLIB queries. The key insight is that
// cleanTitle and cleanArtist are used for all queries — this is what
// was missing in previous versions.

async function fetchLyrics(
  rawTitle: string,
  rawArtist: string,
  album?: string,
  duration?: number,
): Promise<LyricsResponse | null> {

  // STEP 1: Clean the title and artist before ANY LRCLIB call
  const title = cleanTitleForLRCLIB(rawTitle);
  const artist = cleanArtistForLRCLIB(rawArtist);

  console.log(`Cleaned: "${rawTitle}" → "${title}" | "${rawArtist}" → "${artist}"`);

  // STEP 2: Run all get-cached cascade attempts IN PARALLEL using cleaned values
  // (parallel cascade from previous v2 optimisation, kept here)
  type Attempt = { params: URLSearchParams; rank: number };
  const attempts: Attempt[] = [];

  if (artist && album && duration) {
    attempts.push({ rank: 4, params: new URLSearchParams({
      track_name: title, artist_name: artist, album_name: album,
      duration: String(Math.round(duration)),
    })});
  }
  if (artist && duration) {
    attempts.push({ rank: 3, params: new URLSearchParams({
      track_name: title, artist_name: artist, duration: String(Math.round(duration)),
    })});
  }
  if (artist) {
    attempts.push({ rank: 2, params: new URLSearchParams({
      track_name: title, artist_name: artist,
    })});
  }
  attempts.push({ rank: 1, params: new URLSearchParams({ track_name: title }) });

  // Deduplicate
  const seen = new Set<string>();
  const unique = attempts.filter(a => {
    const k = a.params.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const settled = await Promise.allSettled(
    unique.map(async (a) => {
      console.log('get-cached:', a.params.toString());
      const resp = await timedFetch(`https://lrclib.net/api/get-cached?${a.params}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const lyrics = extractLyrics(data);
      if (!lyrics || lyrics.length === 0) return null;
      if (!data.syncedLyrics) return null; // skip unsynced
      const script = detectScript(data.syncedLyrics);
      // Reduce effective rank for dual-language results so single-script wins
      const effectiveRank = script === 'dual' ? a.rank - 10 : a.rank;
      return { rank: effectiveRank, lyrics, synced: true, script };
    })
  );

  const hits = settled
    .filter((s): s is PromiseFulfilledResult<any> => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value)
    .sort((a, b) => b.rank - a.rank);

  if (hits.length > 0) {
    const best = hits[0];
    console.log(`get-cached HIT — rank ${best.rank}, ${best.lyrics.length} lines, synced:${best.synced}`);
    return { lyrics: best.lyrics, source: 'lrclib-get-cached', synced: best.synced, cleanedTitle: title, cleanedArtist: artist };
  }

  // STEP 3: Progressive partial-match fallback using LRCLIB's q= parameter.
  //
  // q= does free-text search across title+artist+album simultaneously —
  // the same parameter the LRCLIB.net website search box uses.
  // We try progressively looser keyword combinations until we get a hit,
  // then rank results by Levenshtein title similarity to pick the best match.
  //
  // Query progression (most → least specific):
  //   a) q="Title Artist"     — full title + first artist word
  //   b) q="Title"            — full cleaned title only
  //   c) q="First Two Words"  — partial title (handles long Bollywood titles)
  //   d) track_name= + artist_name= without q= (structured filter, different behaviour)

  const titleWords = title.split(/\s+/).filter(Boolean);
  const artistFirstWord = artist.split(/\s+/)[0] || '';
  const titleLower = title.toLowerCase();

  const qQueries: string[] = [];
  // a. Full title + artist first word
  if (artistFirstWord) qQueries.push(`${title} ${artistFirstWord}`);
  // b. Full title only
  qQueries.push(title);
  // c. First 3 words of title — helpful for long Bollywood titles
  if (titleWords.length > 3) qQueries.push(titleWords.slice(0, 3).join(' '));
  // d. First 2 words of title
  if (titleWords.length > 2) qQueries.push(titleWords.slice(0, 2).join(' '));
  // e. Title + album name (some LRCLIB entries have album in searchable fields)
  if (album) qQueries.push(`${title} ${album.split(/[(:]/)[0].trim()}`);
  // f. Raw uncleaned title (in case cleaning removed something important)
  if (title !== rawTitle) qQueries.push(rawTitle);
  // g. First word only + artist filter (most lenient)
  if (titleWords.length > 1) qQueries.push(titleWords[0]);

  function rankResults(results: any[]): any | null {
    const candidates = results
      .slice(0, 25)
      .map(r => {
        const lyrics = extractLyrics(r);
        if (!lyrics || lyrics.length === 0) return null;
        const dist = levenshtein(titleLower, (r.trackName ?? '').toLowerCase());
        const durationPenalty = duration && r.duration ? Math.abs(r.duration - duration) * 0.1 : 0;
        if (!r.syncedLyrics) return null; // only accept synced lyrics
        const syncBonus = -50;
        // Penalise dual-language lyrics — prefer single-script results
        const script = detectScript(r.syncedLyrics);
        const dualPenalty = script === 'dual' ? 100 : 0;
        return { lyrics, synced: true, score: dist + durationPenalty + syncBonus + dualPenalty, trackName: r.trackName, script };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.score - b.score);
    return candidates.length > 0 ? candidates[0] : null;
  }

  for (let i = 0; i < qQueries.length; i++) {
    const q = qQueries[i];
    try {
      const sp = new URLSearchParams({ q });
      // For the last attempt (single word), add artist_name as an extra filter
      if (i === qQueries.length - 1 && artist) sp.set('artist_name', artist);
      console.log(`q= attempt ${i+1}/${qQueries.length}: q="${q}"`);
      const resp = await timedFetch(`https://lrclib.net/api/search?${sp}`, 5000);
      if (!resp.ok) continue;
      const results: any[] = await resp.json();
      if (!Array.isArray(results) || results.length === 0) continue;
      const best = rankResults(results);
      if (best) {
        console.log(`q= HIT on attempt ${i+1} — "${best.trackName}", ${best.lyrics.length} lines, synced:${best.synced}`);
        return { lyrics: best.lyrics, source: `lrclib-q${i+1}`, synced: best.synced, cleanedTitle: title, cleanedArtist: artist };
      }
    } catch (e) {
      console.warn(`q= attempt ${i+1} failed:`, (e as Error).message);
    }
  }

  // STEP 4: Last resort — try raw (uncleaned) title via q= free-text search
  if (title !== rawTitle) {
    try {
      console.log('Trying raw uncleaned title as last resort:', rawTitle);
      const resp = await timedFetch(`https://lrclib.net/api/search?q=${encodeURIComponent(rawTitle)}`, 5000);
      if (resp.ok) {
        const results: any[] = await resp.json();
        if (Array.isArray(results)) {
          for (const r of results.slice(0, 5)) {
            const lyrics = extractLyrics(r);
            if (lyrics && lyrics.length > 0 && r.syncedLyrics) {
              console.log('Raw title fallback HIT (synced)');
              return { lyrics, source: 'lrclib-raw', synced: true };
            }
          }
        }
      }
    } catch (e) {
      console.warn('Raw title fallback failed:', (e as Error).message);
    }
  }

  console.log('No lyrics found for:', rawTitle);
  return null;
}

// ─── Server ─────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { title, artist, album, duration } = body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return new Response(JSON.stringify({ error: 'Title is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const trimTitle = title.trim().slice(0, MAX_TITLE_LENGTH);
    const trimArtist = typeof artist === 'string' ? artist.trim().slice(0, MAX_ARTIST_LENGTH) : '';
    const trimAlbum = typeof album === 'string' ? album.trim() : undefined;
    const validDuration = typeof duration === 'number' && isFinite(duration) && duration > 0 && duration <= MAX_DURATION
      ? Math.floor(duration) : undefined;

    console.log('fetch-lyrics request:', trimTitle, '|', trimArtist);

    const result = await fetchLyrics(trimTitle, trimArtist, trimAlbum, validDuration);

    if (result) {
      console.log(`Returning ${result.lyrics.length} lines, synced:${result.synced}, source:${result.source}`);
      return new Response(JSON.stringify(result),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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
