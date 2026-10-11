// =============================================================================
// song-attempts — Supabase Edge Function
// =============================================================================
// Records what happens after someone picks a song from the search results,
// one row per pick in public.song_attempts (see the migration
// 20261011090000_song_attempts.sql). The browser sends small events:
//
//   click       {track, query, position, wasReady, isAlt, device, token?}  -> new row
//   sing_page                                     Sing page opened
//   separated   {ms, fromCache}                   stems ready
//   failed      {ms, error}                       separation failed
//   retry                                         user tapped "Try again"
//   playing                                       song started playing
//   left        {stage}                           left the Sing page / closed the tab
//   prompt                                        "Is the song loading OK?" shown
//   feedback    {answer: 'yes'|'no'}              answer to that question
//
// Every event carries {id, visitorId}; an event only changes the row whose
// id AND visitorId match. Each step keeps the time it FIRST happened.
// Accepts text/plain bodies so the browser can use sendBeacon / simple CORS
// requests (no preflight), including while the tab is closing.
// v1 — CURRENT.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TABLE = "song_attempts";
const MAX_BODY = 8_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TRACK_RE = /^[A-Za-z0-9_-]{1,200}$/;
const SOURCES = new Set(["saavn", "gaana", "youtube"]);
const DEVICES = new Set(["mobile", "tablet", "desktop", "tv"]);
const STAGES = new Set(["waiting", "failed", "ready", "playing"]);

type Row = Record<string, unknown>;

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  });

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// The changes one event makes to an existing row ("first time" columns are
// only set when still empty). Exported for tests.
export function patchFor(event: string, data: Row, row: Row, now: string): Row | null {
  const first = (col: string) => (row[col] == null ? { [col]: now } : {});
  switch (event) {
    case "sing_page":
      return first("sing_page_at");
    case "separated":
      if (row.separated_at != null) return {};
      return {
        separated_at: now,
        separation_ms: int(data.ms, 0, 24 * 3600 * 1000),
        from_cache: bool(data.fromCache),
      };
    case "failed":
      return {
        ...first("failed_at"),
        failed_count: (Number(row.failed_count) || 0) + 1,
        error: str(data.error, 500) ?? "unknown error",
      };
    case "retry":
      return { retry_count: (Number(row.retry_count) || 0) + 1 };
    case "playing":
      return first("playing_at");
    case "left": {
      if (row.left_at != null) return {};
      const stage = typeof data.stage === "string" && STAGES.has(data.stage) ? data.stage : null;
      return { left_at: now, left_stage: stage };
    }
    case "prompt":
      return first("prompt_shown_at");
    case "feedback": {
      const answer = data.answer === "yes" || data.answer === "no" ? data.answer : null;
      if (!answer) return null;
      return { feedback: answer, feedback_at: now };   // latest answer counts
    }
    default:
      return null;
  }
}

// Columns for a new row from a click. Exported for tests.
export function clickRow(id: string, visitorId: string, data: Row, userId: string | null, now: string): Row | null {
  const track = (data.track ?? {}) as Row;
  const trackId = typeof track.id === "string" && TRACK_RE.test(track.id) ? track.id : null;
  if (!trackId) return null;
  return {
    id,
    visitor_id: visitorId,
    user_id: userId,
    device: typeof data.device === "string" && DEVICES.has(data.device) ? data.device : null,
    track_id: trackId,
    title: str(track.title, 300),
    artist: str(track.artist, 300),
    album: str(track.album, 300),
    source: typeof track.source === "string" && SOURCES.has(track.source) ? track.source : null,
    duration_seconds: int(track.durationSeconds, 0, 6 * 3600),
    was_ready: bool(data.wasReady),
    is_alt_version: bool(data.isAlt),
    search_query: str(data.query, 200),
    result_position: int(data.position, 1, 10_000),
    clicked_at: now,
    created_at: now,
    updated_at: now,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return reply(413, { error: "too large" });
    let body: Row;
    try { body = JSON.parse(text); } catch { return reply(400, { error: "invalid JSON" }); }

    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id.toLowerCase() : null;
    const visitorId = typeof body.visitorId === "string" && VISITOR_RE.test(body.visitorId) ? body.visitorId : null;
    const event = typeof body.event === "string" ? body.event : "";
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as Row;
    if (!id || !visitorId) return reply(400, { error: "id and visitorId required" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const now = new Date().toISOString();

    if (event === "click") {
      let userId: string | null = null;
      const token = typeof data.token === "string" ? data.token : "";
      if (token) {
        const { data: auth } = await admin.auth.getUser(token).catch(() => ({ data: { user: null } }));
        userId = auth?.user?.id ?? null;
      }
      const row = clickRow(id, visitorId, data, userId, now);
      if (!row) return reply(400, { error: "invalid track" });
      const { error } = await admin.from(TABLE).upsert(row, { onConflict: "id", ignoreDuplicates: true });
      if (error) {
        console.error("[song-attempts] insert failed:", error.message);
        return reply(500, { error: "could not save" });
      }
      return reply(204);
    }

    const { data: row, error: readError } = await admin.from(TABLE).select("*")
      .eq("id", id).eq("visitor_id", visitorId).maybeSingle();
    if (readError) {
      console.error("[song-attempts] read failed:", readError.message);
      return reply(500, { error: "could not read" });
    }
    if (!row) return reply(404, { error: "unknown attempt" });

    const patch = patchFor(event, data, row as Row, now);
    if (patch === null) return reply(400, { error: `unknown or invalid event: ${event.slice(0, 40)}` });
    if (Object.keys(patch).length === 0) return reply(204);

    const { error } = await admin.from(TABLE).update({ ...patch, updated_at: now })
      .eq("id", id).eq("visitor_id", visitorId);
    if (error) {
      console.error("[song-attempts] update failed:", error.message);
      return reply(500, { error: "could not save" });
    }
    return reply(204);
  } catch (e) {
    console.error("[song-attempts] error:", e instanceof Error ? e.message : e);
    return reply(500, { error: "internal error" });
  }
});
