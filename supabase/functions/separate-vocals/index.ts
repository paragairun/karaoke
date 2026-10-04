// =============================================================================
// separate-vocals — Supabase Edge Function
// =============================================================================
// CHANGELOG
// v1 — Warmup only. Browser called Modal directly for actual separation,
//      with MODAL_API_KEY hardcoded in client-side JS (useVocalSeparation.ts)
//      — visible to anyone via dev tools/view-source. Also meant every
//      unique browser paid Modal's GPU cost separately for the same song,
//      even if thousands of other users had already sung it.
//
// v2 — Added the `separate` action. This is now the ONLY path for
//      running vocal separation — the browser never talks to Modal directly.
//   - Modal's API key lives only here (server-side), never shipped to
//     the client.
//   - Checks Supabase Storage (bucket: separated-audio) for existing
//     {trackId}/instrumental.mp3 + vocals.mp3 BEFORE calling Modal.
//     Storage is a GLOBAL cache shared by every user — the first person to
//     sing a song pays the Modal GPU cost, everyone after gets an instant
//     Storage URL. This replaces the old per-browser IndexedDB cache
//     (audioCache.ts), which only ever benefited the same device replaying
//     the same song.
//   - On a cache miss: calls Modal, downloads both stems server-side,
//     uploads them to Storage, returns the new public Storage URLs.
//   - Response shape kept identical to the old client-side flow
//     ({ instrumentalUrl, vocalsUrl, fromCache }) so Sing.tsx/PartyStage.tsx
//     need minimal changes.
// v3 — CURRENT: reference melody. Modal now also returns pitch_url (a
//      ~70 KB pitch contour computed once per song); it is stored as
//      {trackId}/pitch.json next to the stems and returned as pitchUrl.
//      Cache hits on songs stored before this existed start a background
//      backfill (Modal /pitch-by-url, background tier) and return without
//      pitchUrl; the browser then uses live detection for that play.
//      Melody failures never affect the stems.
//
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Warmup only targets the FAST (A10G) tier -- that's the one live users
// actually wait on (solo singing, first party song). The BACKGROUND (T4)
// tier used for silent party pre-separation warms up naturally on its
// first real call; no need to proactively ping it.
const MODAL_URL_FAST = "https://ajparag--vocal-separator-v3-vocalseparatorfast-ui.modal.run";
const MODAL_URL_BACKGROUND = "https://ajparag--vocal-separator-v3-vocalseparatorbackground-ui.modal.run";
const MODAL_API_KEY = "pa_audio_vWyst7iiPDutgJL5n2zksWxWhZNJRY32";

const STORAGE_BUCKET = "separated-audio";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// Converts a Uint8Array to a base64 string WITHOUT spreading it into
// String.fromCharCode's arguments. Spreading (...bytes) blows the JS
// engine's call stack for anything beyond ~65,000 elements — an MP3 file
// is several million bytes, so the naive version would throw
// "RangeError: Maximum call stack size exceeded" every time this fallback
// path actually ran, defeating its entire purpose (never blocking the user).
// Chunking at 8192 bytes keeps every fromCharCode call well under any
// engine's argument-count limit.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Validates a trackId before it's ever used to build a Storage path.
// Current call sites (Index.tsx, Sing.tsx, PartyStage.tsx) always pass a
// clean ID from search results — but useVocalSeparation.ts's cacheKey
// falls back to the raw audioUrl if trackId is ever omitted, which would
// otherwise get interpolated straight into a Storage path (slashes and
// query params would create a broken nested folder structure). This is
// the server-side backstop against that, regardless of what the client
// does or doesn't send.
function isValidTrackId(trackId: string): boolean {
  if (!trackId || trackId.length === 0 || trackId.length > 200) return false;
  // Alphanumeric plus the handful of separator characters real track IDs
  // use (JioSaavn hashes, Gaana numeric IDs, YouTube video IDs) — no
  // slashes, no query characters, no path traversal sequences.
  return /^[A-Za-z0-9_-]+$/.test(trackId);
}

// ─── Storage helpers ────────────────────────────────────────────────────────

function storagePaths(trackId: string) {
  return {
    instrumental: `${trackId}/instrumental.mp3`,
    vocals: `${trackId}/vocals.mp3`,
    // Reference melody (pitch contour) computed on Modal at separation time.
    // Optional: songs without it fall back to live detection in the browser.
    pitch: `${trackId}/pitch.json`,
  };
}

type StemUrls = { instrumentalUrl: string; vocalsUrl: string; pitchUrl?: string };

function publicUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

// Checks whether both stems already exist in Storage for this track.
// A HEAD-style existence check via list() rather than a full download —
// cheap, just confirms the objects are there before trusting the URLs.
async function checkStorageCache(
  admin: ReturnType<typeof createClient>,
  trackId: string,
): Promise<StemUrls | null> {
  const { data, error } = await admin.storage.from(STORAGE_BUCKET).list(trackId);
  if (error || !data) return null;

  const names = new Set(data.map((f) => f.name));
  if (!names.has("instrumental.mp3") || !names.has("vocals.mp3")) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const paths = storagePaths(trackId);
  return {
    instrumentalUrl: publicUrl(supabaseUrl, paths.instrumental),
    vocalsUrl: publicUrl(supabaseUrl, paths.vocals),
    ...(names.has("pitch.json") ? { pitchUrl: publicUrl(supabaseUrl, paths.pitch) } : {}),
  };
}

// Stores the melody. Best-effort and separate from the stems: a failure
// here never affects the stems, the song just scores with live detection.
async function uploadPitch(
  admin: ReturnType<typeof createClient>,
  trackId: string,
  pitchBytes: Uint8Array,
): Promise<string | undefined> {
  const path = storagePaths(trackId).pitch;
  const { error } = await admin.storage.from(STORAGE_BUCKET).upload(path, pitchBytes, {
    contentType: "application/json",
    upsert: true,
  });
  if (error) {
    console.error("[separate-vocals] Pitch upload failed:", error);
    return undefined;
  }
  return publicUrl(Deno.env.get("SUPABASE_URL")!, path);
}

// Melody for a song cached before pitch.json existed. Runs in the background
// (the user gets the stems immediately and that play uses live detection),
// on the background tier, at most once per song per edge instance.
const backfillsInFlight = new Set<string>();
async function backfillPitch(admin: ReturnType<typeof createClient>, trackId: string, vocalsUrl: string) {
  if (backfillsInFlight.has(trackId)) return;
  backfillsInFlight.add(trackId);
  const t0 = Date.now();
  try {
    const resp = await fetch(`${MODAL_URL_BACKGROUND}/pitch-by-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": MODAL_API_KEY },
      body: JSON.stringify({ audio_url: vocalsUrl }),
      signal: AbortSignal.timeout(180000),
    });
    if (!resp.ok) {
      console.error(`[separate-vocals] Pitch backfill failed for ${trackId}: ${resp.status}`);
      return;
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const url = await uploadPitch(admin, trackId, bytes);
    console.log(`[separate-vocals] Pitch backfill ${url ? "stored" : "not stored"} for ${trackId} in ${Date.now() - t0}ms (${Math.round(bytes.length / 1024)}KB)`);
  } catch (e) {
    console.error(`[separate-vocals] Pitch backfill exception for ${trackId}:`, e);
  } finally {
    backfillsInFlight.delete(trackId);
  }
}

// Keeps a background task alive after the response is sent (Supabase Edge
// Runtime's EdgeRuntime.waitUntil); plain fire-and-forget where unavailable.
function runInBackground(task: Promise<unknown>) {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(task);
  else task.catch(() => {});
}

// Uploads both stems to Storage. Best-effort — if this fails, we still
// return the (now-orphaned) Modal URLs to the client so the user isn't
// blocked; the song just won't be cached for next time.
async function uploadToStorageCache(
  admin: ReturnType<typeof createClient>,
  trackId: string,
  instrumentalBytes: Uint8Array,
  vocalsBytes: Uint8Array,
): Promise<StemUrls | null> {
  const paths = storagePaths(trackId);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

  try {
    const [instRes, vocRes] = await Promise.all([
      admin.storage.from(STORAGE_BUCKET).upload(paths.instrumental, instrumentalBytes, {
        contentType: "audio/mpeg",
        upsert: true,
      }),
      admin.storage.from(STORAGE_BUCKET).upload(paths.vocals, vocalsBytes, {
        contentType: "audio/mpeg",
        upsert: true,
      }),
    ]);

    if (instRes.error || vocRes.error) {
      console.error("[separate-vocals] Storage upload failed:", instRes.error, vocRes.error);
      // Clean up whichever upload DID succeed — otherwise it sits in Storage
      // forever as an orphan (checkStorageCache requires both files present
      // to count as a hit, so a lone instrumental.mp3 is permanently unused
      // dead weight, just quietly costing storage space).
      if (!instRes.error) await admin.storage.from(STORAGE_BUCKET).remove([paths.instrumental]).catch(() => {});
      if (!vocRes.error) await admin.storage.from(STORAGE_BUCKET).remove([paths.vocals]).catch(() => {});
      return null;
    }

    return {
      instrumentalUrl: publicUrl(supabaseUrl, paths.instrumental),
      vocalsUrl: publicUrl(supabaseUrl, paths.vocals),
    };
  } catch (e) {
    console.error("[separate-vocals] Storage upload exception:", e);
    return null;
  }
}

// ─── Modal call ───────────────────────────────────────────────────────────

async function callModal(
  audioUrl: string,
  tier: "fast" | "background",
): Promise<{ instrumentalBytes: Uint8Array; vocalsBytes: Uint8Array; pitchBytes: Uint8Array | null } | null> {
  const modalBase = tier === "background" ? MODAL_URL_BACKGROUND : MODAL_URL_FAST;

  console.log(`[separate-vocals] Calling Modal (${tier}):`, audioUrl.slice(0, 80));
  const t0 = Date.now();

  const resp = await fetch(`${modalBase}/separate-by-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": MODAL_API_KEY },
    body: JSON.stringify({ audio_url: audioUrl }),
    signal: AbortSignal.timeout(120000), // 2 min — separation itself takes ~20-50s
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(`[separate-vocals] Modal error: ${resp.status} ${errText.slice(0, 200)}`);
    return null;
  }

  const result = await resp.json();
  const instPath = result?.instrumental_url;
  const vocPath = result?.vocal_url;
  const pitchPath = result?.pitch_url;
  if (!instPath) {
    console.error("[separate-vocals] No instrumental_url in Modal response");
    return null;
  }

  console.log(`[separate-vocals] Modal separation done in ${Date.now() - t0}ms, downloading stems...`);

  // Modal's response paths are relative to Modal's own domain — fetch the
  // actual file bytes from there so we can re-upload to Supabase Storage.
  const [instResp, vocResp, pitchResp] = await Promise.all([
    fetch(`${modalBase}${instPath}`, { headers: { "x-api-key": MODAL_API_KEY } }),
    vocPath
      ? fetch(`${modalBase}${vocPath}`, { headers: { "x-api-key": MODAL_API_KEY } })
      : Promise.resolve(null),
    pitchPath
      ? fetch(`${modalBase}${pitchPath}`, { headers: { "x-api-key": MODAL_API_KEY } }).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (!instResp.ok) {
    console.error("[separate-vocals] Failed to download instrumental from Modal:", instResp.status);
    return null;
  }

  const instrumentalBytes = new Uint8Array(await instResp.arrayBuffer());
  const vocalsBytes = vocResp && vocResp.ok
    ? new Uint8Array(await vocResp.arrayBuffer())
    : new Uint8Array(0);

  const pitchBytes = pitchResp && pitchResp.ok ? new Uint8Array(await pitchResp.arrayBuffer()) : null;

  console.log(`[separate-vocals] Downloaded stems: inst=${Math.round(instrumentalBytes.length / 1024)}KB vocals=${Math.round(vocalsBytes.length / 1024)}KB pitch=${pitchBytes ? Math.round(pitchBytes.length / 1024) + "KB" : "none"}`);

  return { instrumentalBytes, vocalsBytes, pitchBytes };
}

// ─── Handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    // ── Warmup (unchanged from v1) ──────────────────────────────────────────
    if (action === "warmup") {
      console.log("[separate-vocals] Warmup ping");
      try {
        const resp = await fetch(`${MODAL_URL_FAST}/`, {
          signal: AbortSignal.timeout(45000),
          headers: { "x-api-key": MODAL_API_KEY },
        });
        console.log("[separate-vocals] Warmup status:", resp.status);
        return json({ ready: resp.ok });
      } catch (e) {
        console.warn("[separate-vocals] Warmup failed (non-critical):", e);
        return json({ ready: false });
      }
    }

    // ── Separate — the new global-cache-aware flow ─────────────────────────
    if (action === "separate") {
      const audioUrl = body.audioUrl as string | undefined;
      const trackId = body.trackId as string | undefined;
      const tier = (body.tier === "background" ? "background" : "fast") as "fast" | "background";

      if (!audioUrl || !trackId) {
        return json({ error: "audioUrl and trackId are required" }, 400);
      }
      if (!isValidTrackId(trackId)) {
        console.error("[separate-vocals] Rejected invalid trackId:", trackId.slice(0, 100));
        return json({ error: "Invalid trackId format" }, 400);
      }

      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      // 1. Check the global Storage cache first
      const cached = await checkStorageCache(admin, trackId);
      if (cached) {
        console.log("[separate-vocals] Storage cache HIT for", trackId, cached.pitchUrl ? "(with melody)" : "(no melody yet — backfilling)");
        if (!cached.pitchUrl) runInBackground(backfillPitch(admin, trackId, cached.vocalsUrl));
        return json({ ...cached, fromCache: true });
      }

      console.log("[separate-vocals] Storage cache MISS for", trackId, "— calling Modal");

      // 2. Cache miss — call Modal, download stems server-side
      const stems = await callModal(audioUrl, tier);
      if (!stems) {
        return json({ error: "Vocal separation failed" }, 502);
      }

      // 3. Upload to Storage for every future user of this song
      const uploaded = await uploadToStorageCache(admin, trackId, stems.instrumentalBytes, stems.vocalsBytes);

      if (uploaded) {
        const pitchUrl = stems.pitchBytes ? await uploadPitch(admin, trackId, stems.pitchBytes) : undefined;
        return json({ ...uploaded, ...(pitchUrl ? { pitchUrl } : {}), fromCache: false });
      }

      // Storage upload failed (rare) — fall back to returning the raw bytes
      // as data URLs so the user isn't blocked, just not cached for next time.
      console.warn("[separate-vocals] Storage upload failed, returning inline data URLs as fallback");
      const instB64 = bytesToBase64(stems.instrumentalBytes);
      const vocB64 = stems.vocalsBytes.length > 0 ? bytesToBase64(stems.vocalsBytes) : null;
      return json({
        instrumentalUrl: `data:audio/mpeg;base64,${instB64}`,
        vocalsUrl: vocB64 ? `data:audio/mpeg;base64,${vocB64}` : undefined,
        fromCache: false,
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[separate-vocals] Error:", msg);
    return json({ error: msg }, 500);
  }
});
