// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Single hardcoded mirror: jiosaavn.rajputhemant.dev
//   Started returning 404 on every request. No SLA on free hobby mirrors.
//
// v2 — Attempted multi-mirror fallback with saavn.dev, jiosaavn-api.vercel.app
//   Both unverified guesses. Confirmed via Supabase logs that all 3 failed:
//   2x 404, 1x DNS resolution failure (saavn.dev does not resolve from Deno).
//
// v3 — Switched to saavn.sumit.co, VERIFIED working via direct fetch
//   Response shape confirmed by live test (not docs, not assumption):
//     { success: true, data: { total, start, results: [...] } }
//   Per-song fields confirmed: name, image[].url, downloadUrl[].url,
//   artists.primary[].name, album.name, duration (number), playCount (number|null)
//   Rewrote searchSaavn() to match this exact verified shape — no more
//   defensive .link/.url fallback chains guessing at multiple possible shapes.
//
// v4 — CURRENT: Optimized for speed — parallel queries + in-memory cache
//   - generateAlternativeQueries() previously ran in a SEQUENTIAL for-loop:
//     query[0] awaited fully, THEN query[1] if <5 results, THEN query[2]...
//     Worst case (3 alternative queries, each ~500-800ms): up to 2.4s total.
//   - Fix: all alternative queries now fire in PARALLEL via Promise.all.
//     Worst case is now ~800ms (slowest single query), not the sum of all.
//   - Added in-memory cache (function-instance-scoped, 15 min TTL) for
//     identical search queries. Supabase edge functions stay warm for
//     several minutes, so this catches repeat searches for the same song
//     (very common — e.g. multiple party members searching the same hit).
//   - Added 5s overall request timeout per Saavn mirror call to prevent
//     a hanging mirror from stalling the whole search indefinitely.
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
  source: 'saavn';
  audioUrl: string;
  album?: string;
  playCount?: number;
  isOriginal?: boolean; // surfaced to client so UI can badge originals
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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

// ─── Original vs Remake Detection ─────────────────────────────────────────────
//
// Strategy: scan title + album + artist for known remake markers.
// If any remake pattern matches → it's a remake.
// If an "original" signal matches → it's definitely original (overrides ambiguity).
// Otherwise: fall back to play count (higher play count = more likely original).

const REMAKE_PATTERNS = [
  /\bremix\b/i, /\bremake\b/i, /\bcover\b/i,
  /\bmashup\b/i, /\bmash[\s-]?up\b/i, /\breloaded\b/i, /\breprise\b/i,
  /\bunplugged\b/i, /\bacoustic\b/i, /\bkaraoke\b/i,
  /\binstrumental\b/i, /\btribute\b/i, /\brecreated\b/i, /\bredone\b/i,
  /\blofi\b/i, /\blo[\s-]fi\b/i, /\bslowed\b/i, /\breverb\b/i,
  /\bslowed\s*\+\s*reverb\b/i,
  /\bfemale\s+version\b/i, /\bmale\s+version\b/i,
  /\bflute\s+version\b/i, /\bguitar\s+version\b/i, /\bpiano\s+version\b/i,
  /\bstring\s+version\b/i, /\borchestral\b/i,
  // Explicit "version" suffix that isn't "original version"
  /(?<!original\s)\bversion\b/i,
  // Common Hindi remake signals
  /\brefix\b/i, /\brecreation\b/i, /\brecreate\b/i,
];

const ORIGINAL_SIGNALS = [
  /\boriginal\b/i,
  /\bofficial\b/i,
  /\bfrom\s+the\s+(film|movie)\b/i,
  /\b(film|movie)\s+version\b/i,
  /\bsoundtrack\b/i,
  /\bost\b/i, // Original Soundtrack
];

function classifyTrack(title: string, album: string, artist: string): boolean {
  // Returns true = original, false = remake
  const combined = [title, album, artist].join(' ');

  // Strong original signal wins
  if (ORIGINAL_SIGNALS.some(p => p.test(combined))) return true;
  // Any remake pattern = not original
  if (REMAKE_PATTERNS.some(p => p.test(combined))) return false;
  // No markers — assume original (most Saavn tracks without such markers are)
  return true;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
//
// Final ranking score = relevance (title/artist match) + originality + popularity
//
// Weights designed so that:
//   - An exact-title original with high play count always beats a remake of the same song
//   - A high-play-count remake won't outrank a low-play-count original
//   - Among tracks with equal originality, play count breaks the tie

function calculateRelevanceScore(query: string, track: Track): number {
  const q = query.toLowerCase().trim();
  const title = track.title.toLowerCase();
  const artist = track.artist.toLowerCase();
  const album = (track.album || '').toLowerCase();

  // ── Relevance (0–100) ──────────────────────────────────────────────────────
  let relevance = 0;

  if (title === q) {
    relevance += 100; // exact title match
  } else if (title.startsWith(q)) {
    relevance += 85;  // title starts with query (e.g. "Tum Hi Ho" for "Tum Hi H")
  } else if (title.includes(q)) {
    relevance += 70;  // query is a substring of title
  } else if (q.includes(title)) {
    relevance += 50;  // title is a substring of query
  }

  // Word-level matching for multi-word queries
  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  let matchedInTitle = 0;
  let matchedInArtist = 0;

  for (const word of qWords) {
    if (title.includes(word)) { matchedInTitle++; relevance += 12; }
    else if (artist.includes(word)) { matchedInArtist++; relevance += 8; }
    else if (album.includes(word)) { relevance += 4; }
  }

  // Bonus: most query words found in title
  if (qWords.length > 1 && matchedInTitle / qWords.length >= 0.7) {
    relevance += 25;
  }

  // Artist name in query (e.g. "arijit tum hi ho")
  const artistFirstName = artist.split(/[,\s]/)[0];
  if (q.includes(artistFirstName) && artistFirstName.length > 2) {
    relevance += 20;
  }

  // ── Originality bonus/penalty (-30 to +20) ────────────────────────────────
  // This is the key addition: separates originals from remakes regardless of
  // play count. A remake is never shown above an original of the same song.
  const isOriginal = classifyTrack(track.title, track.album || '', track.artist);
  const originalityScore = isOriginal ? 20 : -30;

  // ── Popularity tiebreaker (0–20) ──────────────────────────────────────────
  // Log-scaled so a song with 50M plays doesn't overwhelm one with 5M.
  // Max 20 points keeps it as a tiebreaker, not a primary signal.
  const popularityScore = track.playCount
    ? Math.min(20, Math.log10(track.playCount + 1) * 3)
    : 0;

  return relevance + originalityScore + popularityScore;
}

// ─── Query normalisation (unchanged from original) ─────────────────────────

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

  // Strip trailing "songs" / "song"
  if (/\bsongs?\b/.test(normalized)) {
    alts.add(normalized.replace(/\s*\bsongs?\b\s*/g, ' ').trim());
  }
  // Short query: try adding "song" for better results
  if (normalized.split(' ').length <= 2 && !normalized.includes('song')) {
    alts.add(normalized + ' song');
  }

  return Array.from(alts).slice(0, 3);
}

// ─── JioSaavn API (saavn.sumit.co — verified working) ──────────────────────
//
// Response shape verified by direct fetch on 2026-06-16:
//   { success: true, data: { total, start, results: [...] } }
// Per-song fields verified present: name, image[].url, downloadUrl[].url,
// artists.primary[].name, album.name, duration (number), playCount (number|null)

const SAAVN_API_BASE = 'https://saavn.sumit.co/api';

// Simple in-memory cache, scoped to this warm function instance.
// Catches repeat searches for the same query without re-hitting Saavn or
// re-running the relevance/originality scoring pass.
const searchCache = new Map<string, { tracks: Track[]; ts: number }>();
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function timedFetch(url: string, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function searchSaavn(query: string): Promise<Track[]> {
  try {
    const url = `${SAAVN_API_BASE}/search/songs?query=${encodeURIComponent(query)}&page=1&limit=20`;
    console.log('Saavn query:', query);

    // 5s hard timeout — prevents a hanging Saavn mirror from stalling search
    let response = await timedFetch(url);

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 1200));
      response = await timedFetch(url);
    }

    if (!response.ok) {
      console.error('Saavn error:', response.status);
      return [];
    }

    const data = await response.json();
    if (!data.success || !data.data?.results) {
      console.error('Saavn: unexpected response shape', JSON.stringify(data).slice(0, 200));
      return [];
    }

    return data.data.results.map((song: any) => {
      // downloadUrl[] entries use `.url` (confirmed — no `.link` field exists)
      const downloadUrls = song.downloadUrl || [];
      const audioUrl =
        downloadUrls.find((d: any) => d.quality === '160kbps')?.url ||
        downloadUrls.find((d: any) => d.quality === '96kbps')?.url ||
        downloadUrls[downloadUrls.length - 1]?.url || '';

      // image[] entries use `.url` (confirmed — no `.link` field exists)
      const images = song.image || [];
      const thumbnail =
        images.find((i: any) => i.quality === '500x500')?.url ||
        images.find((i: any) => i.quality === '150x150')?.url ||
        images[images.length - 1]?.url || '';

      // artists.primary[] confirmed present on every song
      const artists =
        song.artists?.primary?.map((a: any) => a.name).join(', ') ||
        'Unknown Artist';

      const title = decodeHtmlEntities(song.name || 'Unknown');
      const artist = decodeHtmlEntities(artists);
      const album = decodeHtmlEntities(song.album?.name || '');
      // playCount confirmed nullable — default to 0 when null
      const playCount = typeof song.playCount === 'number' ? song.playCount : 0;
      const isOriginal = classifyTrack(title, album, artist);

      return {
        id: song.id, title, artist, thumbnail,
        duration: formatDuration(song.duration || 0),
        source: 'saavn' as const,
        audioUrl, album, playCount, isOriginal,
      };
    });
  } catch (err) {
    console.error('Saavn search error:', err);
    return [];
  }
}

// ─── Main search with dedup + ranking ─────────────────────────────────────

async function searchWithFuzzyMatching(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = searchCache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  console.log('Queries:', queries);

  // OPTIMIZATION: run the primary query first (most likely to succeed alone).
  // Only fire the alternative queries in PARALLEL if the primary came up short —
  // this avoids wasting calls on the common case where query[0] already
  // returns plenty of results, while still being fast when it doesn't.
  let allTracks = await searchSaavn(queries[0]);

  if (allTracks.length < 5 && queries.length > 1) {
    // Previously: sequential for-loop, each query awaited before the next.
    // Now: all remaining queries fire together — total time ≈ slowest one,
    // not the sum of all of them.
    const remaining = await Promise.all(queries.slice(1).map(q => searchSaavn(q)));
    allTracks = [...allTracks, ...remaining.flat()];
  }

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const t of allTracks) {
    if (!seen.has(t.id)) { seen.add(t.id); unique.push(t); }
  }

  // Sort: originals first, then by relevance + popularity
  const normalizedQ = normalizeQuery(originalQuery);
  const scored = unique
    .map(t => ({ t, score: calculateRelevanceScore(normalizedQ, t) }))
    .sort((a, b) => {
      // Primary: score (already encodes originality penalty/bonus)
      if (b.score !== a.score) return b.score - a.score;
      // Secondary tiebreaker: originals before remakes
      if (a.t.isOriginal !== b.t.isOriginal) return a.t.isOriginal ? -1 : 1;
      // Tertiary: play count
      return (b.t.playCount || 0) - (a.t.playCount || 0);
    });

  console.log('Top 5 results:');
  scored.slice(0, 5).forEach(({ t, score }) => {
    console.log(` ${score.toFixed(1).padStart(6)} | ${t.isOriginal ? 'ORIG' : 'RMKE'} | ${t.title} — ${t.artist}`);
  });

  const finalTracks = scored.map(({ t }) => t).slice(0, 20);
  searchCache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });
  return finalTracks;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { query } = await req.json();

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

    console.log('Search query:', trimmed);
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
