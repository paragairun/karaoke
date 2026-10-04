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
// v8 — CURRENT: Gaana results report source 'gaana' (were labelled 'saavn'), so the
//      homepage can show where each result comes from and score records
//      (track_source) say which source was actually sung.
// =============================================================================

// supabase/functions/search-music/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
}

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

  const DEMOTE_KEYWORDS = [
    'remix', 'remixed', 'instrumental', 'karaoke', 'unplugged',
    'lofi', 'lo-fi', 'slowed', 'reverb', 'mashup', 'reprise',
    'recreated', 'rendition', 'revisited', 'reloaded',
    'acoustic version', 'club mix', 'dj mix',
  ];
  let demotionPenalty = 0;
  for (const kw of DEMOTE_KEYWORDS) {
    if (title.includes(kw)) { demotionPenalty = 80; break; }
  }

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
      const tracks = await searchJioSaavnOnly(trimmed);
      console.log(`[JioSaavn-only] Returning ${tracks.length} tracks`);
      return new Response(
        JSON.stringify({ tracks }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tier === 'gaana') {
      const tracks = await searchGaanaOnly(trimmed);
      console.log(`[Gaana-only] Returning ${tracks.length} tracks`);
      return new Response(
        JSON.stringify({ tracks }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tier === 'tier1') {
      const { tracks, shouldFetchMore } = await searchTier1Only(trimmed);
      console.log(`[Tier1] Returning ${tracks.length} tracks, shouldFetchMore: ${shouldFetchMore}`);
      return new Response(
        JSON.stringify({ tracks, shouldFetchMore }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tier === 'tier2') {
      const tracks = await searchTier2Only(trimmed);
      console.log(`[Tier2] Returning ${tracks.length} tracks`);
      return new Response(
        JSON.stringify({ tracks }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tracks = await searchWithFuzzyMatching(trimmed);
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
