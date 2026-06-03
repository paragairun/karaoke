import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Input validation limits
const MAX_TITLE_LENGTH = 200;
const MAX_ARTIST_LENGTH = 200;
const MAX_DURATION = 3600; // 1 hour max
const MIN_DURATION = 0;

interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

interface LyricsResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  lyrics: LyricLine[];
  synced: boolean;
}

interface LyricsResponse {
  lyrics: LyricLine[];
  source: string;
  synced: boolean;
}

interface SearchResultsResponse {
  results: LyricsResult[];
  source: string;
}

// Parse LRC format to structured lyrics
function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const lrcLines = lrc.split('\n');
  
  for (const line of lrcLines) {
    const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
    
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const milliseconds = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
      const text = match[4].trim();
      
      if (text) {
        const time = minutes * 60 + seconds + milliseconds / 1000;
        lines.push({ time, text });
      }
    }
  }
  
  for (let i = 0; i < lines.length; i++) {
    if (i < lines.length - 1) {
      lines[i].duration = lines[i + 1].time - lines[i].time;
    } else {
      lines[i].duration = 5;
    }
  }
  
  return lines.sort((a, b) => a.time - b.time);
}

// Convert plain lyrics to timed format
function convertPlainLyrics(plainLyrics: string): LyricLine[] {
  const lines = plainLyrics.split('\n').filter((l: string) => l.trim());
  const estimatedDuration = 4;
  
  return lines.map((text: string, i: number) => ({
    time: i * estimatedDuration,
    text: text.trim(),
    duration: estimatedDuration,
  }));
}

// Search LRCLIB and return top results
async function searchLRCLIBMultiple(title: string, artist: string): Promise<LyricsResult[]> {
  try {
    const encodedTitle = encodeURIComponent(title);
    const encodedArtist = encodeURIComponent(artist);
    
    // Use search endpoint to get multiple results
    const searchResponse = await fetch(
      `https://lrclib.net/api/search?track_name=${encodedTitle}${artist ? `&artist_name=${encodedArtist}` : ''}`
    );
    
    if (!searchResponse.ok) {
      console.error('LRCLIB search failed:', searchResponse.status);
      return [];
    }
    
    const results = await searchResponse.json();
    
    if (!Array.isArray(results) || results.length === 0) {
      return [];
    }
    
    // Sort results to prioritize synced lyrics first
    const sortedResults = [...results].sort((a: any, b: any) => {
      const aHasSynced = !!a.syncedLyrics;
      const bHasSynced = !!b.syncedLyrics;
      if (aHasSynced && !bHasSynced) return -1;
      if (!aHasSynced && bHasSynced) return 1;
      return 0;
    });
    
    // Take top 3 results after sorting and parse their lyrics
    const top3 = sortedResults.slice(0, 3).map((result: any) => {
      let lyrics: LyricLine[] = [];
      let synced = false;
      
      if (result.syncedLyrics) {
        lyrics = parseLRC(result.syncedLyrics);
        synced = true;
      } else if (result.plainLyrics) {
        lyrics = convertPlainLyrics(result.plainLyrics);
        synced = false;
      }
      
      return {
        id: result.id,
        trackName: result.trackName || title,
        artistName: result.artistName || artist,
        albumName: result.albumName,
        duration: result.duration,
        lyrics,
        synced,
      };
    });
    
    return top3.filter((r: LyricsResult) => r.lyrics.length > 0);
  } catch (error) {
    console.error('LRCLIB search error:', error);
    return [];
  }
}

// Search LRCLIB cached endpoint for instant DB-only lookups (skips slow scraping).
async function searchLRCLIB(
  title: string,
  artist: string,
  album?: string,
  duration?: number,
): Promise<LyricsResponse | null> {
  try {
    const params = new URLSearchParams();
    params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    if (album) params.set('album_name', album);
    if (duration && duration > 0) params.set('duration', String(Math.round(duration)));

    // Server-side timeout matching the client (3s) so we never hang the edge fn.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let response: Response;
    try {
      response = await fetch(
        `https://lrclib.net/api/get-cached?${params.toString()}`,
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (data.syncedLyrics) {
      return {
        lyrics: parseLRC(data.syncedLyrics),
        source: 'lrclib',
        synced: true,
      };
    }

    if (data.plainLyrics) {
      return {
        lyrics: convertPlainLyrics(data.plainLyrics),
        source: 'lrclib',
        synced: false,
      };
    }

    return null;
  } catch (error) {
    console.error('LRCLIB error:', error);
    return null;
  }
}

// Fallback: Generate placeholder lyrics
function generatePlaceholderLyrics(title: string, duration: number): LyricsResponse {
  const numLines = Math.max(10, Math.floor(duration / 4));
  const lineDuration = duration / numLines;
  
  const placeholderLines = [
    `♪ ${title} ♪`,
    '🎤 Lyrics not available',
    '🎵 Sing along to the music!',
    '',
    '♪ ♪ ♪',
  ];
  
  const lyrics: LyricLine[] = [];
  
  for (let i = 0; i < numLines; i++) {
    lyrics.push({
      time: i * lineDuration,
      text: placeholderLines[i % placeholderLines.length] || '♪ ♪ ♪',
      duration: lineDuration,
    });
  }
  
  return {
    lyrics,
    source: 'placeholder',
    synced: false,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { title, artist, album, duration, searchMultiple = false } = body;
    
    // Input validation: title is required and must be a string
    if (!title || typeof title !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Title is required and must be a string' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Trim and validate title length
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Title cannot be empty' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    if (trimmedTitle.length > MAX_TITLE_LENGTH) {
      console.error(`Title too long: ${trimmedTitle.length} characters`);
      return new Response(
        JSON.stringify({ error: `Title too long (max ${MAX_TITLE_LENGTH} characters)` }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Validate artist if provided
    let trimmedArtist = '';
    if (artist !== undefined && artist !== null) {
      if (typeof artist !== 'string') {
        return new Response(
          JSON.stringify({ error: 'Artist must be a string' }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }
      trimmedArtist = artist.trim();
      if (trimmedArtist.length > MAX_ARTIST_LENGTH) {
        console.error(`Artist too long: ${trimmedArtist.length} characters`);
        return new Response(
          JSON.stringify({ error: `Artist too long (max ${MAX_ARTIST_LENGTH} characters)` }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }
    }

    // Validate album if provided
    let trimmedAlbum: string | undefined;
    if (typeof album === 'string' && album.trim().length > 0) {
      trimmedAlbum = album.trim().slice(0, MAX_TITLE_LENGTH);
    }

    // Validate duration (optional)
    let validDuration: number | undefined;
    if (typeof duration === 'number' && isFinite(duration)) {
      if (duration >= MIN_DURATION && duration <= MAX_DURATION) {
        validDuration = Math.floor(duration);
      }
    }

    // Validate searchMultiple
    if (searchMultiple !== undefined && typeof searchMultiple !== 'boolean') {
      return new Response(
        JSON.stringify({ error: 'searchMultiple must be a boolean' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log('Fetching lyrics for:', trimmedTitle, 'by', trimmedArtist, 'searchMultiple:', searchMultiple);
    
    // If searchMultiple is true, return top 3 results for user selection
    if (searchMultiple) {
      const results = await searchLRCLIBMultiple(trimmedTitle, trimmedArtist);
      
      console.log(`Found ${results.length} results from LRCLIB`);
      
      return new Response(
        JSON.stringify({ results, source: 'lrclib' } as SearchResultsResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Default behavior: instant cached lookup only (no slow fallbacks)
    const lyricsResult = await searchLRCLIB(trimmedTitle, trimmedArtist, trimmedAlbum, validDuration);

    if (lyricsResult) {
      console.log(`Found ${lyricsResult.lyrics.length} lines from ${lyricsResult.source}`);
      return new Response(
        JSON.stringify(lyricsResult),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // No cached lyrics — return empty result (client renders "Lyrics not found")
    console.log('No cached lyrics found for', trimmedTitle);
    return new Response(
      JSON.stringify({ lyrics: [], source: 'lrclib', synced: false, notFound: true } as LyricsResponse & { notFound: boolean }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Lyrics fetch error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Failed to fetch lyrics', details: errorMessage }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
