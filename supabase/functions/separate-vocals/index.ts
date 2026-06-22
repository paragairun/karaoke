// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Only handled warmup. Browser called Modal directly (CORS blocked).
//
// v2 — Attempted URL-direct mode: send URL string to Modal's Gradio API.
//   Failed because Gradio's gr.File input type rejects plain strings before
//   they reach app.py — Gradio validates inputs and returns a non-JSON error
//   page, causing callResp.json() to throw → 500 from edge function.
//
// v3 — CURRENT: Server-to-server download + upload via edge function.
//   Browser → Supabase edge function → Modal (no CORS, no browser bandwidth used).
//   The edge function:
//     1. Downloads audio from Saavn CDN (Supabase datacenter → Saavn: ~1-2s)
//     2. Uploads to Modal /gradio_api/upload (Supabase → Modal: ~1-2s)
//     3. Queues predict, gets event_id, returns it to browser
//   Browser then polls for the result directly via separate SSE call.
//   Total overhead: ~2-4s vs browser's ~9-13s (download+upload).
//   No changes to app.py needed — it receives a proper File object as before.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODAL_BASE = "https://ajparag--vocal-separator-v3-vocalseparator-ui.modal.run";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    // ── WARMUP ──────────────────────────────────────────────────────────────
    if (action === "warmup") {
      console.log("[separate-vocals] Warmup ping");
      try {
        const resp = await fetch(`${MODAL_BASE}/`, {
          signal: AbortSignal.timeout(60000), // cold container can take 52s
        });
        console.log("[separate-vocals] Warmup status:", resp.status);
        return new Response(
          JSON.stringify({ ready: resp.ok }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        console.warn("[separate-vocals] Warmup failed:", e);
        return new Response(
          JSON.stringify({ ready: false }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── SEPARATE: server-to-server download + upload ─────────────────────────
    if (action === "separate") {
      const { audioUrl } = body;
      if (!audioUrl) {
        return new Response(
          JSON.stringify({ error: "audioUrl required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Step 1: Download audio from Saavn (datacenter speed: ~1-2s)
      console.log("[separate-vocals] Downloading audio from:", audioUrl.slice(0, 60));
      const t0 = Date.now();
      const audioResp = await fetch(audioUrl, {
        signal: AbortSignal.timeout(30000),
      });
      if (!audioResp.ok) {
        return new Response(
          JSON.stringify({ error: `Failed to download audio: ${audioResp.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const audioBuffer = await audioResp.arrayBuffer();
      const audioBytes = new Uint8Array(audioBuffer);
      const sizeKB = Math.round(audioBytes.length / 1024);
      console.log(`[separate-vocals] Downloaded ${sizeKB}KB in ${Date.now() - t0}ms`);

      // Detect file extension from URL
      const urlPath = audioUrl.split("?")[0];
      const ext = urlPath.split(".").pop()?.toLowerCase() ?? "m4a";
      const safeExt = ["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext) ? ext : "m4a";
      const mimeMap: Record<string, string> = {
        mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
        aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
      };
      const mimeType = mimeMap[safeExt] ?? "audio/mp4";
      const fileName = `track.${safeExt}`;

      // Step 2: Upload to Modal (datacenter speed: ~1-2s)
      console.log("[separate-vocals] Uploading to Modal...");
      const t1 = Date.now();
      const formData = new FormData();
      formData.append("files", new Blob([audioBytes], { type: mimeType }), fileName);

      const uploadResp = await fetch(`${MODAL_BASE}/gradio_api/upload`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(60000),
      });
      if (!uploadResp.ok) {
        const txt = await uploadResp.text();
        console.error("[separate-vocals] Upload failed:", uploadResp.status, txt.slice(0, 200));
        return new Response(
          JSON.stringify({ error: `Upload failed: ${uploadResp.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const uploadJson = await uploadResp.json() as string[];
      const serverPath = uploadJson?.[0];
      if (!serverPath) {
        return new Response(
          JSON.stringify({ error: "No server path from upload" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log(`[separate-vocals] Uploaded in ${Date.now() - t1}ms → ${serverPath}`);

      // Step 3: Queue prediction
      const fileData = {
        path: serverPath,
        orig_name: fileName,
        mime_type: mimeType,
        meta: { _type: "gradio.FileData" },
      };
      const predictResp = await fetch(`${MODAL_BASE}/gradio_api/call/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [fileData] }),
        signal: AbortSignal.timeout(90000), // survive cold start (52s) + queue time
      });
      if (!predictResp.ok) {
        const txt = await predictResp.text();
        console.error("[separate-vocals] Predict call failed:", predictResp.status, txt.slice(0, 200));
        return new Response(
          JSON.stringify({ error: `Predict failed: ${predictResp.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const predictJson = await predictResp.json();
      const eventId = predictJson?.event_id;
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "No event_id from Modal" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[separate-vocals] Predict queued, event_id: ${eventId}`);
      return new Response(
        JSON.stringify({ eventId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── POLL RESULT: read SSE stream from Modal ──────────────────────────────
    if (action === "result") {
      const { eventId } = body;
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "eventId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log("[separate-vocals] Polling SSE for event:", eventId);
      const sseResp = await fetch(
        `${MODAL_BASE}/gradio_api/call/predict/${eventId}`,
        { signal: AbortSignal.timeout(300000) }
      );

      if (!sseResp.ok || !sseResp.body) {
        return new Response(
          JSON.stringify({ error: `SSE stream failed: ${sseResp.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const reader = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resultData: any = null;
      let currentEvent = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (currentEvent === "complete") {
              try {
                resultData = JSON.parse(payload);
                break outer;
              } catch { /* partial line */ }
            } else if (currentEvent === "error") {
              reader.cancel();
              return new Response(
                JSON.stringify({ error: `Modal error: ${payload}` }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
          }
        }
      }
      reader.cancel();

      if (!resultData) {
        return new Response(
          JSON.stringify({ error: "No result from SSE stream" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Extract file paths — resultData is array of file objects or paths
      const getPath = (item: any): string | null =>
        typeof item === "string" ? item : (item?.path ?? null);

      const vocalPath = getPath(resultData[0]);
      const instPath = getPath(resultData[1]);

      console.log("[separate-vocals] Complete. vocal:", vocalPath, "inst:", instPath);

      return new Response(
        JSON.stringify({
          vocalUrl: vocalPath ? `${MODAL_BASE}/gradio_api/file=${vocalPath}` : null,
          instrumentalUrl: instPath ? `${MODAL_BASE}/gradio_api/file=${instPath}` : null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[separate-vocals] Unhandled error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
