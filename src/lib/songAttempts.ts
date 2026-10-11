// =============================================================================
// songAttempts.ts — follows one song pick from the search results to singing
// =============================================================================
// Index.tsx calls startSongAttempt() when a result is clicked; Sing.tsx then
// reports what happens (page opened, separated / failed, playing, left, the
// "Is the song loading OK?" answer) with sendAttemptEvent(). Each pick gets a
// random id kept in sessionStorage for that track, so Sing.tsx only reports
// for songs that really came from a search click (party songs and direct
// links are not tracked).
//
// Events go to the song-attempts edge function as text/plain (a "simple"
// request: no CORS preflight) with keepalive, or via navigator.sendBeacon
// when the page is closing. Fire-and-forget: tracking never blocks or breaks
// the app. Rows: Supabase table song_attempts / view song_attempt_outcomes.
// v1 — first version.
// v2 — CURRENT: the endpoint uses SUPABASE_URL from the Supabase client.
//   v1 used import.meta.env.VITE_SUPABASE_URL, which is an EMPTY string in the
//   production build (the GitHub secret is blank), so every event went to
//   https://karaokeparty.in/functions/v1/song-attempts (GitHub Pages -> 405)
//   and nothing was saved.
// =============================================================================

import { SUPABASE_URL } from "@/integrations/supabase/client";

export const SONG_ATTEMPTS_ENDPOINT = `${SUPABASE_URL}/functions/v1/song-attempts`;
const ENDPOINT = SONG_ATTEMPTS_ENDPOINT;
const VISITOR_KEY = "kp_visitor_id";
const ATTEMPT_KEY = "kp_song_attempt";

export type AttemptEvent =
  | "sing_page" | "separated" | "failed" | "retry" | "playing" | "left" | "prompt" | "feedback";

export interface AttemptTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  source?: string;
  durationSeconds?: number | null;
  ready?: boolean;
}

export interface SongAttempt {
  id: string;
  trackId: string;
  clickedAt: number;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 from getRandomValues (older browsers / TVs without randomUUID)
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let memoryVisitorId: string | null = null;

/** Anonymous id for this browser (kept in localStorage; per-tab if storage is blocked). */
export function getVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const id = randomId().replace(/-/g, "");
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    memoryVisitorId ??= randomId().replace(/-/g, "");
    return memoryVisitorId;
  }
}

/** mobile | tablet | desktop | tv, from the user agent (TVs first: many say "Android"). */
export function detectDevice(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|Roku|Viera|AppleTV/i.test(ua)) return "tv";
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return "mobile";
  return "desktop";
}

function post(body: unknown, beacon = false): void {
  try {
    const payload = JSON.stringify(body);
    if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "text/plain;charset=UTF-8" }))) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: payload,
      keepalive: true,
    }).catch(() => { /* tracking is best-effort */ });
  } catch { /* never let tracking break the app */ }
}

/** Records a click on a search result and remembers it for the Sing page. */
export function startSongAttempt(
  track: AttemptTrack,
  info: { query?: string; position?: number; isAlt?: boolean; accessToken?: string | null },
): SongAttempt {
  const attempt: SongAttempt = { id: randomId(), trackId: track.id, clickedAt: Date.now() };
  try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt)); } catch { /* ignore */ }
  post({
    id: attempt.id,
    visitorId: getVisitorId(),
    event: "click",
    data: {
      track: {
        id: track.id, title: track.title, artist: track.artist, album: track.album,
        source: track.source, durationSeconds: track.durationSeconds ?? null,
      },
      wasReady: !!track.ready,
      isAlt: !!info.isAlt,
      query: info.query,
      position: info.position,
      device: detectDevice(),
      token: info.accessToken ?? undefined,
    },
  });
  return attempt;
}

/** The attempt started by the last search click, if it was for this track. */
export function getSongAttempt(trackId: string | undefined | null): SongAttempt | null {
  if (!trackId) return null;
  try {
    const a = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || "null") as SongAttempt | null;
    return a && a.trackId === trackId && typeof a.id === "string" ? a : null;
  } catch {
    return null;
  }
}

export function sendAttemptEvent(
  attempt: SongAttempt | null,
  event: AttemptEvent,
  data: Record<string, unknown> = {},
  opts: { beacon?: boolean } = {},
): void {
  if (!attempt) return;
  post({ id: attempt.id, visitorId: getVisitorId(), event, data }, opts.beacon);
}
