// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Single hardcoded Saavn API mirror: jiosaavn.rajputhemant.dev
//   This is a personal hobby deployment of an unofficial JioSaavn wrapper.
//   It started returning 404 on every request (confirmed via Supabase logs:
//   "Saavn error: 404" on every single query regardless of search term).
//   These free community mirrors go down or change paths without notice —
//   there is no SLA or stability guarantee.
//
// v2 — CURRENT: Multi-mirror fallback chain
//   Tries multiple known JioSaavn API mirrors in sequence. If one is down
//   or returns a non-2xx/invalid response, automatically tries the next.
//   This makes the app resilient to any single mirror going offline.
//   Mirrors used (in order):
//     1. saavn.dev          — actively maintained, Hono.js based
//     2. jiosaavn-api.vercel.app — sumitkolhe's deployment
//     3. jiosaavn.rajputhemant.dev — original (kept as last resort)
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

// ─── JioSaavn API mirrors ──────────────────────────────────────────────────
//
// Multiple unofficial JioSaavn API mirrors, tried in order. Each mirror has
// a slightly different response shape — normaliseSaavnResult() below handles
// both the "rajputhemant" shape (data.data.results) and the "saavn.dev" /
// "sumitkolhe" shape (data.data.results, same shape — most forks share the
// same convention, but we defensively check both top-level and nested paths).

const SAAVN_MIRRORS = [
  (q: string) => `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`,
  (q: string) => `https://jiosaavn-api.vercel.app/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`,
  (q: string) => `https://jiosaavn.rajputhemant.dev/search/songs?q=${encodeURIComponent(q)}&page=1&n=20&camel=true`,
];

function extractResults(data: any): any[] | null {
  // Handles multiple response shapes across different mirror forks
  if (data?.data?.results && Array.isArray(data.data.results)) return data.data.results;
  if (data?.results && Array.isArray(data.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return null;
}

async function fetchFromMirror(buildUrl: (q: string) => string, query: string): Promise<any[] | null> {
  const url = buildUrl(query);
  try {
    let response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'KaraokeParty/1.0' },
    });

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 1200));
      response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'KaraokeParty/1.0' },
      });
    }

    if (!response.ok) {
      console.warn(`Mirror failed (${response.status}):`, url.split('?')[0]);
      return null;
    }

    const data = await response.json();
    const results = extractResults(data);
    if (!results) {
      console.warn('Mirror returned unrecognised shape:', url.split('?')[0]);
      return null;
    }
    console.log(`Mirror succeeded (${results.length} results):`, url.split('?')[0]);
    return results;
  } catch (err) {
    console.warn('Mirror threw error:', url.split('?')[0], (err as Error).message);
    return null;
  }
}

// ─── JioSaavn API ──────────────────────────────────────────────────────────

async function searchSaavn(query: string): Promise<Track[]> {
  console.log('Saavn query:', query);

  let results: any[] | null = null;
  for (const buildUrl of SAAVN_MIRRORS) {
    results = await fetchFromMirror(buildUrl, query);
    if (results && results.length > 0) break;
  }

  if (!results) {
    console.error('All Saavn mirrors failed for query:', query);
    return [];
  }

  try {
    return results.map((song: any) => {
      const downloadUrls = song.downloadUrl || [];
      const audioUrl =
        downloadUrls.find((d: any) => d.quality === '160kbps')?.link ||
        downloadUrls.find((d: any) => d.quality === '96kbps')?.link ||
        downloadUrls.find((d: any) => d.quality === '160kbps')?.url ||
        downloadUrls.find((d: any) => d.quality === '96kbps')?.url ||
        downloadUrls[downloadUrls.length - 1]?.link ||
        downloadUrls[downloadUrls.length - 1]?.url || '';

      const images = song.image || [];
      const thumbnail =
        images.find((i: any) => i.quality === '500x500')?.link ||
        images.find((i: any) => i.quality === '150x150')?.link ||
        images.find((i: any) => i.quality === '500x500')?.url ||
        images.find((i: any) => i.quality === '150x150')?.url ||
        images[images.length - 1]?.link ||
        images[images.length - 1]?.url || '';

      const artists =
        song.artistMap?.primaryArtists?.map((a: any) => a.name).join(', ') ||
        song.artists?.primary?.map((a: any) => a.name).join(', ') ||
        'Unknown Artist';

      const title = decodeHtmlEntities(song.name || 'Unknown');
      const artist = decodeHtmlEntities(artists);
      const album = decodeHtmlEntities(
        typeof song.album === 'string' ? song.album : song.album?.name || ''
      );
      const playCount = parseInt(song.playCount, 10) || 0;
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
  const queries = generateAlternativeQueries(originalQuery);
  console.log('Queries:', queries);

  let allTracks = await searchSaavn(queries[0]);

  if (allTracks.length < 5 && queries.length > 1) {
    for (let i = 1; i < queries.length; i++) {
      allTracks = [...allTracks, ...await searchSaavn(queries[i])];
    }
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

  return scored.map(({ t }) => t).slice(0, 20);
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
