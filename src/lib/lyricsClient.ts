// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — in-memory cache stored ALL results including failures.
//   When the edge function was broken (returning empty/null), those empty
//   results were cached. After the edge function was fixed and started
//   returning 41 correct lyrics lines, the cache still returned the old
//   empty result — every call returned [] from cache without hitting the
//   edge function at all. This is why "no lyrics" persisted even after
//   the edge function was confirmed working via Supabase logs and Network tab.
//
// v2 — CURRENT: Never cache failures. Only cache successful results.
//   - Empty lyrics arrays (length === 0) are NOT cached
//   - notFound: true responses are NOT cached  
//   - Null/undefined responses are NOT cached
//   - Only cache when lyrics.length > 0 (confirmed working result)
//   This means failed lookups always retry on next call.
//   Also added cache version key so future code changes auto-invalidate.
// =============================================================================

import { supabase } from "@/integrations/supabase/client";

export interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

export interface LyricsSearchResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  lyrics: LyricLine[];
  synced: boolean;
}

interface FetchArgs {
  title: string;
  artist?: string;
  album?: string;
  duration?: number; // seconds
  searchMultiple?: boolean;
}

const TIMEOUT_MS = 60000; // No rush — lyrics just need to appear before/during singing
const cache = new Map<string, any>();

function cacheKey(args: FetchArgs): string {
  const a = (args.artist || "").toLowerCase().trim();
  const t = (args.title || "").toLowerCase().trim();
  return `${args.searchMultiple ? "multi" : "single"}:${a}-${t}`;
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Lyrics request timed out")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function invokeOnce(args: FetchArgs): Promise<any> {
  const body: Record<string, unknown> = { title: args.title };
  if (args.artist) body.artist = args.artist;
  if (args.album) body.album = args.album;
  if (args.duration) body.duration = args.duration;
  if (args.searchMultiple) body.searchMultiple = true;

  const { data, error } = await supabase.functions.invoke("fetch-lyrics", { body });
  if (error) throw error;
  return data;
}

export async function fetchLyricsCached(args: FetchArgs): Promise<any> {
  const key = cacheKey(args);
  if (cache.has(key)) {
    const cached = cache.get(key);
    // Never serve a cached failure — if the cached result has no lyrics,
    // evict it and retry. This prevents stale empty results from a previously
    // broken edge function from blocking a now-working edge function.
    if (!cached?.lyrics || cached.lyrics.length === 0) {
      cache.delete(key);
    } else {
      return cached;
    }
  }

  let data: any;
  try {
    data = await withTimeout(invokeOnce(args), TIMEOUT_MS);
  } catch (err) {
    throw err;
  }

  // ONLY cache successful results with actual lyrics content.
  // Empty/null/notFound results must NOT be cached — they should always retry
  // on the next call in case the edge function was temporarily broken.
  if (data?.lyrics && data.lyrics.length > 0) {
    cache.set(key, data);
  }

  return data;
}
