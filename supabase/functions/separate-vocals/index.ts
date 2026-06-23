// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Only handled warmup. Browser called Modal directly (CORS blocked).
//
// v2 — Attempted URL-direct mode: send URL string to Modal's Gradio API.
//   Failed: Gradio gr.File validates inputs and rejects plain strings.
//
// v3 — Server-to-server download+upload. Correct approach but had two bugs:
//   a) 90s predict timeout — regressive (predict just queues job, responds in <5s)
//   b) No diagnostic logging system
//
// v4 — CURRENT: Correct timeouts + comprehensive diagnostic logging.
//   Architecture (unchanged from v3):
//     Browser → Supabase edge fn → (download from Saavn + upload to Modal) → event_id
//     Browser → Supabase edge fn → poll SSE → stem URLs
//   Timeouts (corrected):
//     Audio download from Saavn : 30s  (server-to-server, ~1-2s actual)
//     Upload to Modal            : 30s  (server-to-server, ~1-2s actual)
//     Predict call (queue only)  : 15s  (just returns event_id, <5s actual)
//     SSE result poll            : 150s (GPU separation, ~17s for 3-min song)
//     Warmup GET                 : 15s  (only checks if container is alive)
//   Note: app.py does NOT need to handle URL inputs. The edge function handles
//   all downloading and sends a proper Gradio FileData object to Modal.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODAL_BASE = "https://ajparag--vocal-separator-v3-vocalseparator-ui.modal.run";

// ─── Diagnostic log system ───────────────────────────────────────────────────
// Every significant step is logged with a timestamp offset from request start.
// These appear in Supabase function logs and can be correlated with browser logs.
function makeTimer() {
  const start = Date.now();
  return (label: string, extra?: string) => {
    const ms = Date.now() - start;
    const msg = `[separate-vocals] +${ms}ms ${label}${extra ? ': ' + extra : ''}`;
    console.log(msg);
    return ms;
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const t = makeTimer();
  t("Request received", req.method);

  try {
    const body = await req.json();
    const { action } = body;
    t("Action", action);

    // ── WARMUP ────────────────────────────────────────────────────────────────
    if (action === "warmup") {
      try {
        t("Pinging Modal container");
        const resp = await fetch(`${MODAL_BASE}/`, {
          signal: AbortSignal.timeout(15000), // 15s — just checks liveness
        });
        t("Warmup response", String(resp.status));
        return new Response(
          JSON.stringify({ ready: resp.ok }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        t("Warmup failed (non-critical)", String(e));
        return new Response(
          JSON.stringify({ ready: false }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── SEPARATE ──────────────────────────────────────────────────────────────
    if (action === "separate") {
      const { audioUrl } = body;
      if (!audioUrl) {
        return new Response(
          JSON.stringify({ error: "audioUrl required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Step 1: Download audio from Saavn (server-to-server, ~1-2s)
      t("Downloading audio", audioUrl.slice(0, 60));
      const audioResp = await fetch(audioUrl, {
        signal: AbortSignal.timeout(30000),
      });
      if (!audioResp.ok) {
        t("Download failed", String(audioResp.status));
        return new Response(
          JSON.stringify({ error: `Audio download failed: ${audioResp.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const audioBuffer = await audioResp.arrayBuffer();
      const sizeKB = Math.round(audioBuffer.byteLength / 1024);
      t("Download complete", `${sizeKB}KB`);

      // Detect format from URL
      const urlPath = audioUrl.split("?")[0];
      const ext = urlPath.split(".").pop()?.toLowerCase() ?? "m4a";
      const safeExt = ["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext) ? ext : "m4a";
      const mimeMap: Record<string, string> = {
        mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
        aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
      };
      const mimeType = mimeMap[safeExt] ?? "audio/mp4";
      const fileName = `track.${safeExt}`;

      // Step 2: Upload to Modal (server-to-server, ~1-2s)
      t("Uploading to Modal", `${fileName} (${mimeType})`);
      const formData = new FormData();
      formData.append("files", new Blob([audioBuffer], { type: mimeType }), fileName);

      const uploadResp = await fetch(`${MODAL_BASE}/gradio_api/upload`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(30000),
      });
      if (!uploadResp.ok) {
        const txt = await uploadResp.text().catch(() => "");
        t("Upload failed", `${uploadResp.status} ${txt.slice(0, 100)}`);
        return new Response(
          JSON.stringify({ error: `Upload failed: ${uploadResp.status}`, detail: txt.slice(0, 200) }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const uploadJson = await uploadResp.json() as string[];
      const serverPath = uploadJson?.[0];
      if (!serverPath) {
        t("Upload returned no path");
        return new Response(
          JSON.stringify({ error: "No server path from upload" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      t("Upload complete", serverPath.slice(0, 60));

      // Step 3: Queue prediction (just returns event_id, ~1-5s)
      const fileData = {
        path: serverPath,
        orig_name: fileName,
        mime_type: mimeType,
        meta: { _type: "gradio.FileData" },
      };

      t("Queuing predict");
      const predictResp = await fetch(`${MODAL_BASE}/gradio_api/call/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [fileData] }),
        signal: AbortSignal.timeout(15000), // 15s — just queues job, returns event_id fast
      });
      if (!predictResp.ok) {
        const txt = await predictResp.text().catch(() => "");
        t("Predict call failed", `${predictResp.status} ${txt.slice(0, 100)}`);
        return new Response(
          JSON.stringify({ error: `Predict failed: ${predictResp.status}`, detail: txt.slice(0, 200) }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const predictJson = await predictResp.json();
      const eventId = predictJson?.event_id;
      if (!eventId) {
        t("No event_id in predict response", JSON.stringify(predictJson).slice(0, 100));
        return new Response(
          JSON.stringify({ error: "No event_id from Modal predict" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      t("Predict queued", eventId);

      return new Response(
        JSON.stringify({ eventId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── RESULT: poll SSE stream ───────────────────────────────────────────────
    if (action === "result") {
      const { eventId } = body;
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "eventId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      t("Polling SSE", eventId);
      const sseResp = await fetch(
        `${MODAL_BASE}/gradio_api/call/predict/${eventId}`,
        { signal: AbortSignal.timeout(150000) } // 150s max for GPU separation
      );

      if (!sseResp.ok || !sseResp.body) {
        t("SSE stream failed", String(sseResp.status));
        return new Response(
          JSON.stringify({ error: `SSE failed: ${sseResp.status}` }),
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
                t("SSE complete event received");
                break outer;
              } catch { /* partial line, keep reading */ }
            } else if (currentEvent === "error") {
              reader.cancel();
              t("SSE error event", payload.slice(0, 100));
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
        t("SSE stream ended with no result");
        return new Response(
          JSON.stringify({ error: "No result from SSE stream" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Extract file paths from Gradio result
      const getPath = (item: any): string | null =>
        typeof item === "string" ? item : (item?.path ?? null);

      const vocalPath = getPath(resultData[0]);
      const instPath = getPath(resultData[1]);

      t("Separation complete", `vocal=${vocalPath?.slice(-20)} inst=${instPath?.slice(-20)}`);

      return new Response(
        JSON.stringify({
          vocalUrl: vocalPath ? `${MODAL_BASE}/gradio_api/file=${vocalPath}` : null,
          instrumentalUrl: instPath ? `${MODAL_BASE}/gradio_api/file=${instPath}` : null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    t("Unknown action", action);
    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    t("Unhandled error", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
