// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Single hardcoded mirror: jiosaavn.rajputhemant.dev
//   Started returning 404 on every request. No SLA on free hobby mirrors.
//
// v2 — Attempted multi-mirror fallback with saavn.dev, jiosaavn-api.vercel.app
//   Both unverified guesses. Confirmed via Supabase logs that all 3 failed.
//
// v3 — Switched to saavn.sumit.co, VERIFIED working via direct fetch.
//
// v4 — Optimized for speed — parallel queries + in-memory cache.
//
// v5 — Three-tier CASCADE — JioSaavn → self-hosted wrapper → YouTube.
//   Root cause of v4 failure: JioSaavn blocks cloud IPs silently — returns
//   { total: 0, results: [] } with a 200 OK, indistinguishable from a real
//   zero-match search. All cloud providers affected: GCP, AWS, Render, Railway.
//   Cascade logic: only tried Plan B if Plan A was empty, only tried Plan C
//   if Plan B was also empty. Good for resilience, bad for breadth — users
//   only ever saw ONE source's results, even when the others had different
//   or better versions of the same song.
//
// v6 — Three sources queried in PARALLEL, results MERGED, all on every
//   search. All three (JioSaavn, Gaana, YouTube) called simultaneously every
//   time. Whatever came back got pooled together, deduplicated by ID, and
//   ranked by the same relevance+popularity scoring.
//   Problem: YouTube (yt-dlp) is meaningfully slower than the other two —
//   up to 15s on a genuinely novel query — and including it in EVERY
//   search added real, noticeable buffering time even when JioSaavn+Gaana
//   alone already had plenty of good results.
//
// v7 — Two-tier instead of flat three-way parallel.
//   Tier 1 (always): JioSaavn + Gaana in parallel — both fast (~1-3s), no
//     latency cost to always querying both.
//   Tier 2 (fallback only): YouTube — only called when Tier 1's combined
//     result count is below MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK (5). Most
//     searches never touch YouTube at all and stay fast; only genuinely
//     thin searches pay the extra latency to find more results.
// v8 — Gaana results report source 'gaana' (were labelled 'saavn'), so the
//      homepage can show where each result comes from and score records
//      (track_source) say which source was actually sung.
// v9 — CURRENT: tidier results (rules shared with src/lib/searchGrouping.ts).
//      Duplicate versions (same title/artist/length within 5 s on different
//      albums) are merged into one result with altVersions; already-separated
//      songs are marked ready (instant, no GPU cost) and ranked a little
//      higher; versions over 8 min rank lower, over 12 min much lower and are
//      flagged long; live/medley/remix/etc. rank lower unless searched for;
//      play counts that look like bad data are hidden and ignored.
// =============================================================================

// supabase/functions/search-music/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_QUERY_LENGTH = 500;

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn' | 'gaana' | 'youtube';
  audioUrl: string;
  album?: string;
  playCount?: number;
  language?: string;
  releaseDate?: string;
  year?: number;
  // Added by finalizeResults():
  ready?: boolean;          // already separated: starts instantly, no GPU cost
  long?: boolean;           // over 12 min: shown with a warning
  altVersions?: Track[];    // the same recording on other albums/ids
}

// ─── Result tidying rules (KEEP IN SYNC with src/lib/searchGrouping.ts) ──────
// BEGIN SHARED RULES
const SAME_SONG_DURATION_TOLERANCE_S = 5;
const LONG_VERSION_S = 12 * 60;       // warning + strong demotion
const LONGISH_VERSION_S = 8 * 60;     // mild demotion

const UNUSUAL_VERSION_WORDS = [
  'live', 'medley', 'mashup', 'remix', 'remixed', 'unplugged', 'lofi', 'lo-fi',
  'slowed', 'reverb', 'sped up', '8d', 'reprise', 'recreated', 'rendition',
  'revisited', 'reloaded', 'instrumental', 'karaoke', 'cover', 'jhankar',
  'club mix', 'dj mix', 'acoustic version', 'non-stop', 'nonstop', 'jukebox',
];
const LONG_QUERY_WORDS = /\b(long|extended|full|jukebox|non-?stop|medley|mashup)\b/i;

/** "4:13" / "1:02:03" / 253 -> seconds; undefined if unknown. */
function durationToSeconds(d: string | number | undefined | null): number | undefined {
  if (typeof d === 'number') return Number.isFinite(d) && d > 0 ? d : undefined;
  if (!d) return undefined;
  const parts = String(d).trim().split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return undefined;
  const s = parts.reduce((acc, n) => acc * 60 + n, 0);
  return s > 0 ? s : undefined;
}

/** Title for comparison: lower case, "(From ...)" tags and punctuation removed. */
function normalizeSongTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[([]\s*from\b[^)\]]*[)\]]/g, ' ')      // (From "Film") / [From ...]
    .replace(/\s-\s*from\s.*$/g, ' ')                  // - From "Film"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First listed artist, lower case. */
function primaryArtist(artist: string): string {
  return (artist || '')
    .toLowerCase()
    .split(/,|&|\band\b|\bfeat\.?\b|\bft\.?\b|\bx\b/)[0]
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface Songish { title: string; artist: string; duration?: string | number }

function sameSong(a: Songish, b: Songish): boolean {
  const da = durationToSeconds(a.duration), db = durationToSeconds(b.duration);
  if (da === undefined || db === undefined) return false;
  if (Math.abs(da - db) > SAME_SONG_DURATION_TOLERANCE_S) return false;
  return normalizeSongTitle(a.title) === normalizeSongTitle(b.title)
    && primaryArtist(a.artist) === primaryArtist(b.artist)
    && normalizeSongTitle(a.title) !== '';
}

const hasWord = (text: string, word: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/** The unusual-version word in the title the user did NOT ask for, or null. */
function unusualVersionWord(title: string, query: string): string | null {
  for (const w of UNUSUAL_VERSION_WORDS) {
    if (hasWord(title, w) && !hasWord(query, w)) return w;
  }
  return null;
}

/** Ranking penalty for long versions (0 when the search asks for one). */
function lengthPenalty(durationS: number | undefined, query: string, title = ''): number {
  if (!durationS || LONG_QUERY_WORDS.test(query)) return 0;
  // Searched for live/medley/... and this result is one: those run longer.
  if (UNUSUAL_VERSION_WORDS.some(w => hasWord(query, w) && hasWord(title, w))) return 0;
  if (durationS > LONG_VERSION_S) return 160;   // > unusual (80) + longish (50) + Ready bonus (20)
  if (durationS > LONGISH_VERSION_S) return 50;
  return 0;
}

function isLongVersion(durationS: number | undefined): boolean {
  return !!durationS && durationS > LONG_VERSION_S;
}
// END SHARED RULES

// ─── Utilities ────────────────────────────────────────────────────────────────

function timedFetch(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function calculateRelevanceScore(query: string, track: Track): number {
  const q = query.toLowerCase().trim();
  const title = track.title.toLowerCase();
  const artist = track.artist.toLowerCase();
  const album = (track.album || '').toLowerCase();

  let relevance = 0;
  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  const titleWords = title.split(/\s+/);
  let matchedInTitle = 0;

  for (const qw of qWords) {
    const inTitle = titleWords.some(tw => tw.includes(qw) || qw.includes(tw));
    if (inTitle) { matchedInTitle++; relevance += 5; }
    else if (artist.includes(qw)) { relevance += 3; }
    else if (album.includes(qw)) { relevance += 2; }
  }

  const matchRatio = qWords.length > 0 ? matchedInTitle / qWords.length : 0;
  if (matchRatio >= 1.0) relevance += 30;
  else if (matchRatio >= 0.7) relevance += 20;
  else if (matchRatio >= 0.5) relevance += 10;

  const artistFirstName = artist.split(/[,\s]/)[0];
  if (q.includes(artistFirstName) && artistFirstName.length > 2) relevance += 10;

  const popularityScore = track.playCount
    ? Math.min(150, (Math.log10(track.playCount + 1) - 4) * 37.5)
    : 0;

  // Unusual versions (live, medley, remix...) rank lower unless the search
  // asks for that kind of version; long versions rank lower unless the
  // search asks for a long one (rules shared with the app, see above).
  const demotionPenalty = (unusualVersionWord(track.title, q) ? 80 : 0)
    + lengthPenalty(durationToSeconds(track.duration), q, track.title);
  return relevance + popularityScore - demotionPenalty;
}

// ─── Query normalisation ───────────────────────────────────────────────────

const typoFixes: Record<string, string> = {
  'arjit': 'arijit', 'arjith': 'arijit', 'arijith': 'arijit',
  'shreya ghosal': 'shreya ghoshal', 'shreya goshal': 'shreya ghoshal',
  'atif aslaam': 'atif aslam', 'neha kakar': 'neha kakkar',
  'badsha': 'badshah', 'kesaria': 'kesariya', 'kesarya': 'kesariya',
  'tumhi ho': 'tum hi ho', 'tumhiho': 'tum hi ho',
  'channamereya': 'channa mereya',
};

function normalizeQuery(query: string): string {
  let q = query.toLowerCase().trim().replace(/\s+/g, ' ');
  for (const [typo, fix] of Object.entries(typoFixes)) {
    if (q.includes(typo)) q = q.replace(typo, fix);
  }
  return q;
}

function generateAlternativeQueries(query: string): string[] {
  const normalized = normalizeQuery(query);
  const alts: Set<string> = new Set([normalized]);
  if (/\bsongs?\b/.test(normalized)) {
    alts.add(normalized.replace(/\s*\bsongs?\b\s*/g, ' ').trim());
  }
  if (normalized.split(' ').length <= 2 && !normalized.includes('song')) {
    alts.add(normalized + ' song');
  }
  return Array.from(alts).slice(0, 3);
}

// ─── JioSaavn: sumitkolhe/jiosaavn-api (self-hosted fork on Render) ───────────

// v4 — Switched to a self-hosted fork of sumitkolhe/jiosaavn-api on Render
//   (jiosaavn-ckkv.onrender.com), since saavn.sumit.co started going
//   offline very regularly. Confirmed field-for-field identical response
//   shape via a real live request before making this change — same
//   {success, data:{results:[...]}} wrapper, same downloadUrl quality
//   tiers (160kbps/96kbps/etc), same image quality variants, same
//   artists.primary structure. This is genuinely the same underlying
//   software (the root page's own metadata links to saavn.dev, Sumit
//   Kolhe's official reference deployment) — a pure URL swap, no parsing
//   logic changed.
const SAAVN_API_BASE = 'https://jiosaavn-ckkv.onrender.com/api';

async function fetchSaavnPage(query: string, page: number): Promise<any[] | null> {
  try {
    const url = `${SAAVN_API_BASE}/search/songs?query=${encodeURIComponent(query)}&page=${page}&limit=40`;
    let response = await timedFetch(url);
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 1200));
      response = await timedFetch(url);
    }
    if (!response.ok) {
      console.error(`Saavn error (page ${page}):`, response.status);
      return null;
    }
    const data = await response.json();
    if (!data.success || !data.data?.results) {
      console.error(`Saavn: unexpected response shape (page ${page})`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    // Return null specifically when total === 0 — signals IP block, not a
    // genuine empty query. Just means Plan A contributes nothing to the
    // merged pool this time; Plan B and C run independently regardless.
    if (data.data.total === 0) return null;
    return data.data.results;
  } catch (err) {
    console.error(`Saavn page ${page} fetch error:`, err);
    return null;
  }
}

async function searchJioSaavn(query: string): Promise<Track[]> {
  console.log('[JioSaavn] jiosaavn-ckkv.onrender.com query:', query);
  const PAGES_TO_FETCH = 4;
  const pageResults = await Promise.all(
    Array.from({ length: PAGES_TO_FETCH }, (_, i) => fetchSaavnPage(query, i + 1))
  );

  if (pageResults.every(p => p === null)) {
    console.log('[JioSaavn] all pages null/empty — contributing 0 results to merged pool');
    return [];
  }

  const seenIds = new Set<string>();
  const merged: any[] = [];
  for (const page of pageResults) {
    if (!page) continue;
    for (const song of page) {
      if (song?.id && !seenIds.has(song.id)) {
        seenIds.add(song.id);
        merged.push(song);
      }
    }
  }

  return merged.map((song: any): Track => {
    const downloadUrls = song.downloadUrl || [];
    const isSar = (u: any) => typeof u?.url === 'string' && u.url.includes('_sar_');
    const audioUrl =
      downloadUrls.find((d: any) => d.quality === '160kbps' && !isSar(d))?.url ||
      downloadUrls.find((d: any) => d.quality === '96kbps' && !isSar(d))?.url ||
      downloadUrls.find((d: any) => d.quality === '160kbps')?.url ||
      downloadUrls.find((d: any) => d.quality === '96kbps')?.url ||
      downloadUrls[downloadUrls.length - 1]?.url || '';

    const images = song.image || [];
    const thumbnail =
      images.find((i: any) => i.quality === '500x500')?.url ||
      images.find((i: any) => i.quality === '150x150')?.url ||
      images[images.length - 1]?.url || '';

    const artists = song.artists?.primary?.map((a: any) => a.name).join(', ') || 'Unknown Artist';
    const playCount = typeof song.playCount === 'number' ? song.playCount : 0;
    const language = typeof song.language === 'string' ? song.language.toLowerCase() : undefined;
    const releaseDate = typeof song.releaseDate === 'string' ? song.releaseDate : undefined;
    const year = typeof song.year === 'number' ? song.year
      : typeof song.year === 'string' && /^\d{4}$/.test(song.year) ? parseInt(song.year, 10)
      : undefined;

    return {
      id: song.id,
      title: decodeHtmlEntities(song.name || 'Unknown'),
      artist: decodeHtmlEntities(artists),
      thumbnail,
      duration: formatDuration(song.duration || 0),
      source: 'saavn',
      audioUrl,
      album: decodeHtmlEntities(song.album?.name || ''),
      playCount, language, releaseDate, year,
    };
  });
}

// ─── Gaana: GaanaPy (gaanapy-2ta9.onrender.com) ─────────────────────────
//
// Self-hosted fork of ZingyTomato/GaanaPy deployed on Render.
// Returns HLS stream URLs (signed, expire in ~4hrs) — acceptable since
// users won't wait that long between search and singing.
// play_count field is a string like "180M+" — not useful for ranking.
// popularity field has the raw number "180431071~180431071" — we parse
// the first part for ranking.
// Configured via GAANA_API_URL secret.

async function searchGaana(query: string): Promise<Track[]> {
  const gaanaBase = Deno.env.get('GAANA_API_URL');
  if (!gaanaBase) {
    console.log('[Gaana] GAANA_API_URL not set — skipping');
    return [];
  }

  console.log('[Gaana] Gaana query:', query);
  try {
    // GaanaPy's app.py defines this route as "/songs/search/" (trailing
    // slash) with `FastAPI(redirect_slashes=False)` — meaning FastAPI will
    // NOT auto-redirect a no-slash request to the slashed version like it
    // normally would. Omitting the trailing slash here was a silent 404
    // for every single Gaana search once the Render deploy was refreshed
    // to the current main branch (confirmed via Render's own request logs).
    // limit reduced 20 -> 10. GaanaPy's search_songs() fetches full track
    // details for each result via asyncio.gather — genuinely parallel, not
    // sequential (confirmed by reading the actual source). But parallel
    // execution time is bounded by the SLOWEST of the N concurrent
    // requests, not their sum — each additional track is another chance
    // to draw an unlucky, slow straggler from Gaana's backend. Fewer
    // parallel requests = less exposure to that tail latency. 10 results
    // combined with JioSaavn's own results is still plenty for a search list.
    const url = `${gaanaBase.replace(/\/$/, '')}/songs/search/?query=${encodeURIComponent(query)}&limit=10`;
    const response = await timedFetch(url, 10000);
    if (!response.ok) {
      console.error('[Gaana] Gaana error:', response.status);
      return [];
    }

    const data = await response.json();
    const rawList: any[] = Array.isArray(data) ? data : [];

    if (rawList.length === 0) {
      console.log('[Gaana] Gaana returned empty — contributing 0 results to merged pool');
      return [];
    }

    console.log(`[Gaana] Gaana returned ${rawList.length} results`);
    return rawList
      .filter((s: any) => s?.stream_urls?.urls?.very_high_quality || s?.stream_urls?.urls?.high_quality)
      .map((s: any): Track => {
        const durationSecs = parseInt(s.duration, 10) || 0;
        // popularity is "180431071~180431071" — parse first number
        const popularityRaw = typeof s.popularity === 'string' ? s.popularity.split('~')[0] : '0';
        const playCount = parseInt(popularityRaw, 10) || 0;
        // prefer highest quality HLS stream
        const audioUrl =
          s.stream_urls?.urls?.very_high_quality ||
          s.stream_urls?.urls?.high_quality ||
          s.stream_urls?.urls?.medium_quality || '';
        const thumbnail =
          s.images?.urls?.large_artwork ||
          s.images?.urls?.medium_artwork ||
          s.images?.urls?.small_artwork || '';
        const releaseDate = typeof s.release_date === 'string' ? s.release_date : undefined;
        const year = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : undefined;

        return {
          id: s.track_id || s.seokey,
          title: decodeHtmlEntities(s.title || 'Unknown'),
          artist: decodeHtmlEntities(s.artists || 'Unknown Artist'),
          thumbnail,
          duration: formatDuration(durationSecs),
          source: 'gaana',
          audioUrl,
          album: decodeHtmlEntities(s.album || ''),
          playCount,
          language: typeof s.language === 'string' ? s.language.toLowerCase() : undefined,
          releaseDate,
          year,
        };
      });
  } catch (err) {
    console.error('[Gaana] Gaana fetch error:', err);
    return [];
  }
}

// ─── YouTube: self-hosted yt-dlp Flask server ──────────────────────────────

async function searchYouTube(query: string): Promise<Track[]> {
  const ytBase = Deno.env.get('YOUTUBE_SEARCH_URL');
  if (!ytBase) {
    console.log('[YouTube] YOUTUBE_SEARCH_URL not set — skipping');
    return [];
  }

  console.log('[YouTube] YouTube/yt-dlp query:', query);
  try {
    const url = `${ytBase.replace(/\/$/, '')}/search?query=${encodeURIComponent(query)}`;
    const response = await timedFetch(url, 15000); // tightened from 30s — always in
    // the critical path now (parallel, not last-resort fallback); yt-dlp's own
    // 15-min server-side cache means only genuinely novel queries hit this ceiling
    if (!response.ok) {
      console.error('[YouTube] error:', response.status);
      return [];
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      console.error('[YouTube] unexpected response shape');
      return [];
    }

    console.log(`[YouTube] returned ${data.length} results`);
    return data
      .filter((t: any) => t?.id && t?.audioUrl && t?.title)
      .map((t: any): Track => ({
        id: t.id,
        title: decodeHtmlEntities(t.title || 'Unknown'),
        artist: decodeHtmlEntities(t.artist || 'Unknown Artist'),
        thumbnail: t.thumbnail || '',
        duration: t.duration || '0:00',
        source: 'youtube',
        audioUrl: t.audioUrl,
        album: decodeHtmlEntities(t.album || ''),
        playCount: typeof t.playCount === 'number' ? t.playCount : 0,
      }));
  } catch (err) {
    console.error('[YouTube] fetch error:', err);
    return [];
  }
}

// ─── Cache + ranking ──────────────────────────────────────────────────────

const searchCache = new Map<string, { tracks: Track[]; ts: number }>();
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;

// MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK: if JioSaavn+Gaana together already
// return this many results, skip YouTube. YouTube (via yt-dlp) is
// meaningfully slower than the other two — up to 15s on a genuinely novel
// query. Shared by both the legacy combined path and the new tiered path
// below, so the threshold can never drift out of sync between the two.
const MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK = 5;

// Shared by every search path — dedupes by ID and ranks by the same
// relevance+popularity scoring, regardless of which source(s) the pool
// came from. Kept as one function so tier1-only, tier2-only, and the
// legacy combined path can never silently apply different ranking logic.
function dedupeAndRank(tracks: Track[], normalizedForCache: string): Track[] {
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const t of tracks) {
    if (!seen.has(t.id)) { seen.add(t.id); unique.push(t); }
  }

  const scored = unique
    .map(t => ({ t, score: calculateRelevanceScore(normalizedForCache, t) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.t.playCount || 0) - (a.t.playCount || 0);
    });

  console.log('Top 5 results:');
  scored.slice(0, 5).forEach(({ t, score }) => {
    console.log(` ${score.toFixed(1).padStart(6)} | ${(t.playCount||0).toLocaleString().padStart(12)} | ${t.source} | ${t.title} — ${t.artist}`);
  });

  return scored.map(({ t }) => t);
}

// =============================================================================
// LEGACY combined path — UNCHANGED from before this update.
// Still used whenever the request omits `tier` entirely. Kept fully intact
// so any caller that hasn't been updated to the new tiered flow (currently:
// PartyStage.tsx, PartyQueue.tsx) keeps working exactly as it did before —
// this update is purely additive, nothing about this function's behavior
// changed.
// =============================================================================

async function searchWithFuzzyMatching(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = searchCache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  console.log('Queries:', queries);

  const [jioSaavnResults, gaanaResults] = await Promise.all([
    (async () => {
      let results = await searchJioSaavn(queries[0]);
      if (results.length < 5 && queries.length > 1) {
        const remaining = await Promise.all(queries.slice(1).map(q => searchJioSaavn(q)));
        results = [...results, ...remaining.flat()];
      }
      return results;
    })(),
    searchGaana(queries[0]),
  ]);

  let allTracks = [...jioSaavnResults, ...gaanaResults];
  console.log(`Tier 1 (JioSaavn + Gaana) — JioSaavn: ${jioSaavnResults.length}, Gaana: ${gaanaResults.length}, combined: ${allTracks.length}`);

  if (allTracks.length < MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK) {
    console.log(`Tier 1 combined (${allTracks.length}) below threshold (${MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK}) — falling back to YouTube`);
    const youtubeResults = await searchYouTube(queries[0]);
    console.log(`Tier 2 (YouTube fallback) returned: ${youtubeResults.length}`);
    allTracks = [...allTracks, ...youtubeResults];
  }

  const finalTracks = dedupeAndRank(allTracks, normalizedForCache);
  searchCache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });
  return finalTracks;
}

// =============================================================================
// NEW tiered path — lets the client render Tier 1 immediately and fetch
// Tier 2 separately/later, instead of one call blocking until whichever
// tier finishes last. Two independent caches so a repeat search is fast
// on both tiers regardless of whether the client ends up needing tier2.
// =============================================================================

const tier1Cache = new Map<string, { tracks: Track[]; ts: number }>();
const tier2Cache = new Map<string, { tracks: Track[]; ts: number }>();

async function searchTier1Only(originalQuery: string): Promise<{ tracks: Track[]; shouldFetchMore: boolean }> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = tier1Cache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('[Tier1] Search cache HIT:', normalizedForCache);
    return { tracks: cached.tracks, shouldFetchMore: cached.tracks.length < MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK };
  }

  const queries = generateAlternativeQueries(originalQuery);
  console.log('[Tier1] Queries:', queries);

  const [jioSaavnResults, gaanaResults] = await Promise.all([
    (async () => {
      let results = await searchJioSaavn(queries[0]);
      if (results.length < 5 && queries.length > 1) {
        const remaining = await Promise.all(queries.slice(1).map(q => searchJioSaavn(q)));
        results = [...results, ...remaining.flat()];
      }
      return results;
    })(),
    searchGaana(queries[0]),
  ]);

  const combined = [...jioSaavnResults, ...gaanaResults];
  console.log(`[Tier1] JioSaavn: ${jioSaavnResults.length}, Gaana: ${gaanaResults.length}, combined: ${combined.length}`);

  const finalTracks = dedupeAndRank(combined, normalizedForCache);
  tier1Cache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });

  return { tracks: finalTracks, shouldFetchMore: finalTracks.length < MIN_RESULTS_BEFORE_YOUTUBE_FALLBACK };
}

async function searchTier2Only(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = tier2Cache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('[Tier2] Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  console.log('[Tier2] Calling YouTube for:', queries[0]);

  const youtubeResults = await searchYouTube(queries[0]);
  console.log(`[Tier2] YouTube returned: ${youtubeResults.length}`);

  const finalTracks = dedupeAndRank(youtubeResults, normalizedForCache);
  tier2Cache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });
  return finalTracks;
}

// =============================================================================
// FURTHER split: JioSaavn-only and Gaana-only, independently callable.
//
// Tier1 above already runs JioSaavn+Gaana in parallel — but it still
// Promise.all's them together server-side, so the CLIENT doesn't see
// anything until BOTH finish. If Gaana is slow (e.g. its Render free-tier
// backend cold-starting after 15 min idle — a real, known 30-50s penalty,
// not hypothetical), the whole tier1 response is gated on that even though
// JioSaavn itself may have answered in 1-2s.
//
// These two let the CLIENT fire both in parallel and render each the
// moment ITS OWN response lands — genuinely reduces time-to-first-result,
// though NOT total time for everything to finish (that's still bounded by
// whichever source is actually slowest; no way around that without fixing
// the slow source itself).
// =============================================================================

const jioSaavnOnlyCache = new Map<string, { tracks: Track[]; ts: number }>();
const gaanaOnlyCache = new Map<string, { tracks: Track[]; ts: number }>();

async function searchJioSaavnOnly(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = jioSaavnOnlyCache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('[JioSaavn-only] Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  let results = await searchJioSaavn(queries[0]);
  if (results.length < 5 && queries.length > 1) {
    const remaining = await Promise.all(queries.slice(1).map(q => searchJioSaavn(q)));
    results = [...results, ...remaining.flat()];
  }

  const finalTracks = dedupeAndRank(results, normalizedForCache);
  jioSaavnOnlyCache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });
  return finalTracks;
}

async function searchGaanaOnly(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = gaanaOnlyCache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('[Gaana-only] Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  const results = await searchGaana(queries[0]);

  const finalTracks = dedupeAndRank(results, normalizedForCache);
  gaanaOnlyCache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });
  return finalTracks;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

// ─── Final tidy-up of every response ────────────────────────────────────────

// JioSaavn sometimes returns the SAME play count for unrelated albums (seen in
// production: every "He Ram He Ram" result showed 36.2L). When one value covers
// most of a source's results, the counts are treated as unreliable for that
// response: hidden and left out of ranking (they can add up to 150 points).
function dropUnreliablePlayCounts(tracks: Track[]): Track[] {
  const bySource = new Map<string, Track[]>();
  for (const t of tracks) bySource.set(t.source, [...(bySource.get(t.source) ?? []), t]);
  const unreliable = new Set<string>();
  for (const [source, list] of bySource) {
    const counts = new Map<number, number>();
    for (const t of list) if (t.playCount) counts.set(t.playCount, (counts.get(t.playCount) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    if (list.length >= 3 && top >= 3 && top / list.length >= 0.5) unreliable.add(source);
  }
  if (unreliable.size) console.log(`[Search] Unreliable play counts from: ${[...unreliable].join(", ")}`);
  return tracks.map(t => unreliable.has(t.source) ? { ...t, playCount: undefined } : t);
}

// Which results are already separated (stems in Storage). Checked for the top
// results only, in parallel, with a short overall timeout; cached briefly.
const READY_CHECK_LIMIT = 25;
const READY_CACHE_MS = 60 * 1000;
const readyCache = new Map<string, { ready: boolean; ts: number }>();
async function readyIds(ids: string[]): Promise<Set<string>> {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const out = new Set<string>();
  if (!url || !key) return out;
  const admin = createClient(url, key);
  const todo: string[] = [];
  for (const id of ids) {
    const c = readyCache.get(id);
    if (c && Date.now() - c.ts < READY_CACHE_MS) { if (c.ready) out.add(id); } else todo.push(id);
  }
  const checks = todo.map(async id => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
    const { data } = await admin.storage.from("separated-audio").list(id, { limit: 10 });
    const names = new Set((data ?? []).map((f: { name: string }) => f.name));
    const ready = names.has("instrumental.mp3") && names.has("vocals.mp3");
    readyCache.set(id, { ready, ts: Date.now() });
    if (ready) out.add(id);
  });
  await Promise.race([Promise.allSettled(checks), new Promise(r => setTimeout(r, 1500))]);
  return out;
}

const READY_BOOST = 20;

async function finalizeResults(tracks: Track[], query: string): Promise<Track[]> {
  if (!tracks.length) return tracks;
  const q = query.toLowerCase().trim();
  const cleaned = dropUnreliablePlayCounts(tracks);
  const ready = await readyIds(cleaned.slice(0, READY_CHECK_LIMIT).map(t => t.id));
  const scored = cleaned
    .map(t => ({ t: { ...t, ready: ready.has(t.id) || undefined, long: isLongVersion(durationToSeconds(t.duration)) || undefined },
                 score: calculateRelevanceScore(q, t) + (ready.has(t.id) ? READY_BOOST : 0) }))
    .sort((a, b) => b.score - a.score);
  // Merge duplicate versions; a Ready copy becomes the one shown.
  const groups: Track[] = [];
  for (const { t } of scored) {
    const g = groups.find(x => sameSong(x, t));
    if (!g) { groups.push(t); continue; }
    if (t.ready && !g.ready) {
      const { altVersions = [], ...prev } = g;
      Object.assign(g, t, { altVersions: [prev, ...altVersions] });
    } else {
      g.altVersions = [...(g.altVersions ?? []), t].slice(0, 5);
    }
  }
  return groups;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { query, tier } = await req.json();

    if (!query || typeof query !== 'string' || !query.trim()) {
      return new Response(
        JSON.stringify({ error: 'Query is required and must be a non-empty string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const trimmed = query.trim();
    if (trimmed.length > MAX_QUERY_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Query too long (max ${MAX_QUERY_LENGTH} chars)` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // tier: 'tier1' -> JioSaavn+Gaana only, fast, tells the client whether
    //   it's worth following up with tier2.
    // tier: 'tier2' -> YouTube only, called separately by the client after
    //   rendering tier1, only when tier1 said shouldFetchMore.
    // tier omitted -> LEGACY single-call combined behavior, byte-identical
    //   to before this change. Existing callers (PartyStage.tsx,
    //   PartyQueue.tsx) haven't been updated to the tiered flow yet and
    //   keep working exactly as they did.
    if (tier === 'jiosaavn') {
      const tracks = await finalizeResults(await searchJioSaavnOnly(trimmed), trimmed);
      console.log(`[JioSaavn-only] Returning ${tracks.length} tracks`);
      return new Response(
        JSON.stringify({ tracks }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tier === 'gaana') {
      const tracks = await finalizeResults(await searchGaanaOnly(trimmed), trimmed);
      console.log(`[Gaana-only] Returning ${tracks.length} tracks`);
      return new Response(
        JSON.stringify({ tracks }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tier === 'tier1') {
      const tier1 = await searchTier1Only(trimmed);
      const shouldFetchMore = tier1.shouldFetchMore;
      const tracks = await finalizeResults(tier1.tracks, trimmed);
      console.log(`[Tier1] Returning ${tracks.length} tracks, shouldFetchMore: ${shouldFetchMore}`);
      return new Response(
        JSON.stringify({ tracks, shouldFetchMore }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tier === 'tier2') {
      const tracks = await finalizeResults(await searchTier2Only(trimmed), trimmed);
      console.log(`[Tier2] Returning ${tracks.length} tracks`);
      return new Response(
        JSON.stringify({ tracks }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tracks = await finalizeResults(await searchWithFuzzyMatching(trimmed), trimmed);
    console.log(`Returning ${tracks.length} tracks`);

    return new Response(
      JSON.stringify({ tracks }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Search error:', msg);
    return new Response(
      JSON.stringify({ error: 'Search failed', details: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
