// =============================================================================
// CHANGELOG
// v1 -- Fixes the "briefly flashes 404 then redirects home" bug seen after
//   Google OAuth sign-in. Detects an in-flight OAuth callback (hash contains
//   'access_token=') BEFORE mounting HashRouter, waits for Supabase to
//   confirm the session, then mounts the real router.
//
// v2 -- Fixes a second bug this exposed — after Google OAuth, the
//   user ALWAYS landed on '/' regardless of which page they started from
//   (e.g. clicking "Sign in to host" from /party/host).
//
//   Root cause: Google's redirectTo is anchored to window.location.origin
//   + '/' (required — see Auth.tsx's own changelog for why). Supabase then
//   appends the session token to the URL hash on return. Auth.tsx's
//   sessionStorage-based "return to where I came from" logic only runs
//   if Auth.tsx itself mounts — but after this round-trip, the hash never
//   contains '/auth' again, so Auth.tsx never re-mounts and that logic
//   never fires. HashRouter always ends up showing '/' (Index).
//
//   Fix: this component is the ONE place guaranteed to run after every
//   OAuth round-trip, regardless of entry page (it's above HashRouter).
//   Once the session is confirmed, if a redirect target was stashed in
//   sessionStorage (set synchronously on click by whichever page sent the
//   user to /auth), write it directly into window.location.hash BEFORE
//   HashRouter mounts. HashRouter then renders that route on first paint
//   instead of defaulting to '/'.
//
// v3 -- CURRENT: clean URLs (App.tsx v3 uses BrowserRouter). The redirect
//   target is applied with history.replaceState instead of writing the hash,
//   which also removes the used "#access_token=..." from the address bar.
//   Detection is unchanged: Supabase still returns the token in the hash.
// =============================================================================

import { useEffect, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";

function looksLikeOAuthCallback(): boolean {
  return window.location.hash.includes("access_token=");
}

export function AuthCallbackGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => !looksLikeOAuthCallback());

  useEffect(() => {
    if (ready) return; // no callback in progress, nothing to wait for

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;

      // Send the user to wherever they were headed before Google OAuth took
      // over the page (e.g. "/party/host"), and drop the "#access_token=..."
      // fragment from the address bar (Supabase has consumed it by now).
      // Must happen BEFORE setReady(true) mounts the router, so its first
      // render already matches the right route — no flash of Index.
      let path = window.location.pathname;
      try {
        const target = sessionStorage.getItem('authRedirectTo');
        if (target) {
          sessionStorage.removeItem('authRedirectTo');
          path = target.startsWith('/') ? target : `/${target}`;
        }
      } catch { /* sessionStorage unavailable — stay on the current path */ }
      window.history.replaceState(null, "", path);

      setReady(true);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        finish();
      }
    });

    // Safety net: if Supabase doesn't fire an event quickly (e.g. the
    // token was invalid/expired), don't leave the user stuck forever --
    // reveal the app after 3s regardless (the router then shows the
    // current path, or the stored redirect target).
    const timeout = setTimeout(finish, 3000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [ready]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Signing you in...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
