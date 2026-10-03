import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Scoring rules mirrored from src/lib/vocalScoring.ts (an edge function can't
// import from src/). Keep these two in sync with SCORE_WEIGHTS and
// ratingForScore there.
const SCORE_WEIGHTS = { accuracy: 0.5, flow: 0.25, expression: 0.25 };
const RATING_THRESHOLDS: Array<[number, string]> = [
  [900, "L"], [800, "S"], [700, "A"], [600, "B"], [500, "C"], [300, "D"],
];
function ratingForScore(score: number): string {
  for (const [min, letter] of RATING_THRESHOLDS) if (score >= min) return letter;
  return "F";
}
// Total from components (null = no data, left out and weights renormalised).
function combineScore(acc: number | null, flow: number | null, expr: number | null): number | null {
  if (acc === null) return null;
  let sum = acc * SCORE_WEIGHTS.accuracy;
  let weight = SCORE_WEIGHTS.accuracy;
  if (flow !== null) { sum += flow * SCORE_WEIGHTS.flow; weight += SCORE_WEIGHTS.flow; }
  if (expr !== null) { sum += expr * SCORE_WEIGHTS.expression; weight += SCORE_WEIGHTS.expression; }
  return Math.max(0, Math.min(1000, Math.round((sum / weight) * 10)));
}
// Components arrive rounded to whole percent, so a recomputed total can
// legitimately differ from the client's by up to 5 points.
const SCORE_TOLERANCE = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") {
    if (required) throw new Error("Invalid text field");
    return null;
  }

  const cleaned = value.trim().replace(/[<>]/g, "").slice(0, maxLength);
  if (required && cleaned.length === 0) throw new Error("Missing required text field");
  return cleaned.length ? cleaned : null;
}

function cleanInteger(value: unknown, min: number, max: number, fallback: number | null = null) {
  if (value === null || value === undefined) {
    if (fallback === null) throw new Error("Missing numeric field");
    return fallback;
  }

  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Invalid numeric field");
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Resolves "City, Country" from the request's client IP when the client
// didn't already provide a city (this is the "no sign-in" / anonymous path
// -- signed-in users may have set a city on their profile in the future,
// but for now this covers everyone who submits without one).
// Uses ipapi.co (free tier, HTTPS, no API key needed for light usage).
// Any failure here is swallowed -- a broken geolocation lookup should never
// block a score submission, it just means city stays null.
async function geolocateFromIP(ip: string | null): Promise<string | null> {
  if (!ip || ip === "unknown") return null;
  try {
    const resp = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.error) return null; // ipapi.co returns { error: true, reason } on failure/rate-limit
    const city = typeof data.city === "string" && data.city.trim() ? data.city.trim() : null;
    const country = typeof data.country_name === "string" && data.country_name.trim() ? data.country_name.trim() : null;
    if (city && country) return `${city}, ${country}`;
    return city || country || null;
  } catch (e) {
    console.warn("[submit-score] IP geolocation failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // Auth is OPTIONAL. Signed-in users get their score attributed to
    // their account (userId set, feeds their profile stats via the
    // on_score_created trigger). Anyone else -- no account, no login --
    // still gets their score saved to the public leaderboard, just with
    // user_id left NULL. City/country for these anonymous submissions is
    // resolved from their IP address further below.
    const authHeader = req.headers.get("authorization");
    let userId: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      // getUser() is the stable method available in all supabase-js v2.x.
      // getClaims() was used before but is unstable/unavailable in some
      // versions and was causing the 500 crash.
      const { data: userData } = await authClient.auth.getUser();
      userId = userData?.user?.id ?? null;
    }

    const body = await req.json();
    const clientScore = cleanInteger(body.score, 0, 1000);

    const durationSeconds = cleanInteger(body.durationSeconds, 0, 24 * 60 * 60, 0);
    const minimumSessionSeconds = Math.min(20, Math.max(5, Math.floor(durationSeconds * 0.25)));
    const playedSeconds = cleanInteger(body.playedSeconds, 0, 24 * 60 * 60, 0);

    if (durationSeconds > 0 && playedSeconds < minimumSessionSeconds) {
      return json({ error: "Song session was too short to submit a score" }, 400);
    }

    const songTitle = cleanText(body.songTitle, 200, true)!;
    const trackId = cleanText(body.trackId, 200, true)!;
    const songArtist = cleanText(body.songArtist, 200);
    const thumbnailUrl = cleanText(body.thumbnailUrl, 1000);
    const displayName = cleanText(body.displayName, 50);
    // Column names are historical: timing_accuracy = Accuracy (pitch),
    // rhythm_accuracy = Flow, expression_accuracy = Expression.
    // null = the component had no data (stored as null, not 0).
    const timingAccuracy = body.timingAccuracy != null ? cleanInteger(body.timingAccuracy, 0, 100) : null;
    const rhythmAccuracy = body.rhythmAccuracy != null ? cleanInteger(body.rhythmAccuracy, 0, 100) : null;
    const expressionAccuracy = body.expressionAccuracy != null
      ? cleanInteger(body.expressionAccuracy, 0, 100) : null;

    // The stored score must agree with its stored components. If the client's
    // total is off by more than rounding allows, store the recomputed total.
    const recomputed = combineScore(timingAccuracy, rhythmAccuracy, expressionAccuracy);
    let score = clientScore;
    if (recomputed !== null && Math.abs(recomputed - clientScore) > SCORE_TOLERANCE) {
      console.warn(`[submit-score] score ${clientScore} inconsistent with components -> storing ${recomputed}`);
      score = recomputed;
    }
    // Rating is always derived here from the stored score, never trusted from the client.
    const rating = ratingForScore(score);

    // ── New analytics fields — all optional, non-fatal if missing ────────────
    // These are stored purely for future scoring calibration and analysis.
    // They never affect the score itself — just capture the raw signals
    // that produced it so we can recalibrate constants later.
    const completionRatio = (body.completionRatio != null && Number.isFinite(Number(body.completionRatio)))
      ? Math.max(0, Math.min(1, Number(body.completionRatio))) : null;
    const voicedFrames = body.voicedFrames != null
      ? cleanInteger(body.voicedFrames, 0, 1_000_000, 0) : null;
    const refActiveFrames = body.refActiveFrames != null
      ? cleanInteger(body.refActiveFrames, 0, 1_000_000, 0) : null;
    const noiseFloor = (body.noiseFloor != null && Number.isFinite(Number(body.noiseFloor)))
      ? Math.max(0, Math.min(1, Number(body.noiseFloor))) : null;
    const trackSource = cleanText(body.trackSource, 20) || null;
    const trackLanguage = cleanText(body.trackLanguage, 50) || null;

    // x-forwarded-for is the standard header for the originating client IP
    // behind Supabase's edge runtime proxy; first entry is the real client.
    const forwardedFor = req.headers.get("x-forwarded-for");
    const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : null;

    let city = cleanText(body.city, 50);
    if (!city) {
      const geolocated = await geolocateFromIP(clientIp);
      city = geolocated ? cleanText(geolocated, 50) : null;
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // stageId -- present only when the song was sung as part of a Party
    // session. Links this score row to the party for the party leaderboard.
    // NULL for all solo (non-party) submissions.
    const stageId = cleanText(body.stageId, 100) || null;

    const { data, error } = await adminClient
      .from("scores")
      .insert({
        user_id: userId,
        song_title: songTitle,
        song_artist: songArtist,
        track_id: trackId,
        thumbnail_url: thumbnailUrl,
        score,
        rating,
        rhythm_accuracy: rhythmAccuracy,
        timing_accuracy: timingAccuracy,
        duration_seconds: durationSeconds,
        display_name: displayName,
        city,
        ip_address: userId ? null : clientIp,
        stage_id: stageId,
        expression_accuracy: expressionAccuracy,
        completion_ratio: completionRatio,
        voiced_frames: voicedFrames,
        ref_active_frames: refActiveFrames,
        noise_floor: noiseFloor,
        track_source: trackSource,
        track_language: trackLanguage,
      })
      .select("id")
      .single();

    if (error) throw error;

    return json({ id: data.id });
  } catch (error) {
    // Log the FULL error so Supabase function logs show the real cause
    // (Postgres constraint violation, auth issue, etc.) rather than just
    // the generic wrapper message.
    console.error("[submit-score] Error:", error);
    if (error instanceof Error) {
      console.error("[submit-score] Stack:", error.stack);
    }
    const message = error instanceof Error ? error.message : "Failed to submit score";
    return json({ error: message }, 500);
  }
});
