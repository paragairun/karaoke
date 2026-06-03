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

const TIMEOUT_MS = 3000;
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
  if (cache.has(key)) return cache.get(key);

  let data: any;
  try {
    data = await withTimeout(invokeOnce(args), TIMEOUT_MS);
  } catch (err) {
    // Retry once
    try {
      data = await withTimeout(invokeOnce(args), TIMEOUT_MS);
    } catch (err2) {
      throw err2;
    }
  }
  cache.set(key, data);
  return data;
}
