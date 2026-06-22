// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Only handled warmup requests. Actual separation was done
//   client-side (browser → Modal directly). This caused CORS errors because
//   Modal does not return Access-Control-Allow-Origin headers for browser
//   cross-origin requests. URL-direct mode timed out after 150s before
//   falling back, making separation SLOWER than before.
//
// v2 — CURRENT: Handles both warmup AND URL-pass-through server-side.
//   Browser → Supabase edge function → Modal (server-to-server, no CORS).
//   The browser never talks to Modal directly.
//
//   Endpoints (via POST body action field):
//   - { action: 'warmup' }
//       Pings Modal to wake the container. Server-to-server, fast.
//   - { action: 'separate', audioUrl: 'https://...' }
//       Passes the Saavn URL to Modal server-side. Modal fetches the audio
//       directly (app.py urllib.request, <1s download). Returns event_id.
//   - { action: 'result', eventId: '...' }
//       Polls the SSE stream from Modal and returns stems when ready.
//       Streams the result back as JSON { vocalUrl, instrumentalUrl }.
//
//   Net effect: browser never downloads or uploads audio.
//   Total overhead reduced from ~13s (download+upload) to ~1s (URL string).
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
      console.log("[separate-vocals] Warmup request");
      try {
        const resp = await fetch(`${MODAL_BASE}/`, {
          method: "GET",
          signal: AbortSignal.timeout(10000),
        });
        console.log("[separate-vocals] Warmup response:", resp.status);
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

    // ── SEPARATE: pass URL to Modal server-side ──────────────────────────────
    if (action === "separate") {
      const { audioUrl } = body;
      if (!audioUrl) {
        return new Response(
          JSON.stringify({ error: "audioUrl required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log("[separate-vocals] Sending URL to Modal:", audioUrl.slice(0, 60));

      // Send URL string directly — app.py detects it is a URL and fetches
      // it server-side with urllib.request (<1s vs browser's 5-9s download)
      const callResp = await fetch(`${MODAL_BASE}/gradio_api/call/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [audioUrl] }),
        signal: AbortSignal.timeout(30000),
      });

      if (!callResp.ok) {
        const txt = await callResp.text();
        console.error("[separate-vocals] Modal predict call failed:", callResp.status, txt);
        return new Response(
          JSON.stringify({ error: `Modal rejected request: ${callResp.status}`, detail: txt }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const callJson = await callResp.json();
      const eventId = callJson?.event_id;
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "No event_id from Modal" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log("[separate-vocals] Got event_id:", eventId);
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

      console.log("[separate-vocals] Polling result for event:", eventId);

      const sseResp = await fetch(
        `${MODAL_BASE}/gradio_api/call/predict/${eventId}`,
        { signal: AbortSignal.timeout(300000) } // 5 min max
      );

      if (!sseResp.ok || !sseResp.body) {
        return new Response(
          JSON.stringify({ error: `SSE stream failed: ${sseResp.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Read SSE stream until we get a "complete" event with data
      const reader = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resultData: any = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: complete")) {
            // Next data: line contains the result
          } else if (line.startsWith("data: ") && resultData === null) {
            try {
              const parsed = JSON.parse(line.slice(6));
              // Check if this is the final result (array of file paths)
              if (Array.isArray(parsed) && parsed.length >= 2) {
                resultData = parsed;
                break;
              }
            } catch { /* ignore partial lines */ }
          }
        }
        if (resultData) break;
      }
      reader.cancel();

      if (!resultData) {
        return new Response(
          JSON.stringify({ error: "No result data from Modal SSE stream" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Extract vocal and instrumental paths from the result
      // resultData is [vocalFileData, instrumentalFileData]
      const vocalPath = resultData[0]?.path ?? resultData[0];
      const instPath = resultData[1]?.path ?? resultData[1];

      console.log("[separate-vocals] Separation complete:", vocalPath, instPath);

      return new Response(
        JSON.stringify({
          vocalPath,
          instrumentalPath: instPath,
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
    console.error("[separate-vocals] Error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
