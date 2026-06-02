import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@gradio/client@1.8.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AAC_SPACE = "https://ajparag--vocal-separator-v3-ui.modal.run/";

async function requireUser(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await supabase.auth.getClaims(token);
  return error || !data?.claims ? null : data.claims.sub;
}

async function warmUpSpace(hfToken: string): Promise<boolean> {
  try {
    console.log("[separate-vocals] Warming up HF space...");
    const startTime = Date.now();
    await Client.connect(AAC_SPACE, {
      hf_token: hfToken as `hf_${string}`,
    });
    const elapsed = Date.now() - startTime;
    console.log(`[separate-vocals] Space warmed up in ${elapsed}ms`);
    return true;
  } catch (error) {
    console.warn("[separate-vocals] Warm-up failed:", error);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const userId = await requireUser(req);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();

    if (body.warmUp) {
      console.log("[separate-vocals] Received warm-up request", { userId });
      const HF_TOKEN = Deno.env.get("HF_TOKEN");
      if (!HF_TOKEN) {
        return new Response(
          JSON.stringify({ ready: false, error: "HF_TOKEN not configured" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const ready = await warmUpSpace(HF_TOKEN);
      return new Response(
        JSON.stringify({ ready }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Only warm-up requests are supported. Separation is done client-side." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[separate-vocals] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
