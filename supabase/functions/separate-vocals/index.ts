// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Warmup only. Browser called Modal directly but was CORS-blocked.
//
// v2-v4 — Attempted to proxy everything through edge function.
//   Failed because Supabase edge functions cannot reliably make outbound
//   TCP connections to Modal (upload times out after 30s every time).
//
// v5 — CURRENT: Warmup only (restored). Browser calls Modal directly.
//   CORS is now handled by CORSMiddleware in modal_app.py, so the browser
//   can upload, predict, and read SSE from Modal without CORS errors.
//   The edge function only handles warmup (a lightweight GET, not an upload).
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

    if (action === "warmup") {
      console.log("[separate-vocals] Warmup ping");
      try {
        // Timeout must be long enough for @modal.enter() to complete:
        // model load (~8s) + cuDNN warmup separation (~15s) = ~23s.
        // 15s was too short — warmup returned ready=false while container
        // was still booting, causing the cold start penalty to be paid
        // during the real separation request instead.
        const resp = await fetch(`${MODAL_BASE}/`, {
          signal: AbortSignal.timeout(45000),
        });
        console.log("[separate-vocals] Warmup status:", resp.status);
        return new Response(
          JSON.stringify({ ready: resp.ok }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        console.warn("[separate-vocals] Warmup failed (non-critical):", e);
        return new Response(
          JSON.stringify({ ready: false }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
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
