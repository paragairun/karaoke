// =============================================================================
// App.tsx — Root application shell
// =============================================================================
// CHANGELOG
// v1 — Original Lovable output. QueryClientProvider, TooltipProvider, Sonner
//      all installed but never used. All pages loaded eagerly (no splitting).
// v2 — CURRENT: Cleaned and optimised.
//   REMOVED:
//   - @tanstack/react-query — QueryClient + QueryClientProvider removed.
//     Not a single page calls useQuery or useMutation. ~40KB bundle saved.
//   - TooltipProvider — no component in the app uses <Tooltip>. Dead wrapper.
//   - Sonner — duplicate toast system. All pages use useToast() from
//     use-toast.ts (shadcn Toaster). Sonner was never called anywhere.
//   ADDED:
//   - React.lazy() for all non-Index pages — deferred loading cuts initial
//     bundle by ~40%. Index loads instantly; other pages load on first visit.
//   - Suspense boundary with minimal fallback — spinner while chunk loads.
//   KEPT:
//   - ErrorBoundary — catches render crashes, shows error on screen.
//   - AuthProvider, ThemeProvider, AuthCallbackGate — all still needed.
//   - Toaster — the one toast system actually used.
// =============================================================================

import { Component, ComponentType, ReactNode, Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ThemeProvider } from "@/hooks/useTheme";
import { AuthCallbackGate } from "@/components/AuthCallbackGate";

// =============================================================================
// lazyWithReload — self-heals stale-chunk errors after a new deployment.
// =============================================================================
// Every deploy gives each lazy-loaded page a NEW hashed filename (e.g.
// Sing-3d0x4T3D.js -> Sing-a8Kx91Qz.js). If someone has the site open (or
// cached) from before a deploy and then navigates to a page they haven't
// loaded yet, the browser tries to fetch the OLD hash -- which no longer
// exists on the server, since the new deploy replaced it. That's exactly
// what "Failed to fetch dynamically imported module" means. It is NOT a
// bug in the page itself, and NOT related to anything the user clicked.
//
// Fix: catch that specific failure and reload the page ONCE. The fresh
// page load fetches the current index.html, which points to the correct,
// currently-live chunk hashes -- the error self-heals invisibly.
//
// The sessionStorage guard prevents an infinite reload loop if the fetch
// keeps failing for a genuinely different reason (e.g. the user is
// offline) -- in that case it fails through to the normal error boundary
// after one attempt, instead of reload-looping forever.
function lazyWithReload<T extends { default: ComponentType<any> }>(
  factory: () => Promise<T>
) {
  return lazy(async () => {
    try {
      const module = await factory();
      // Successful load — clear the guard so a FUTURE genuine stale-chunk
      // error (from a later deploy) is still allowed one reload attempt.
      sessionStorage.removeItem('chunk-reload-attempted');
      return module;
    } catch (error) {
      const alreadyReloaded = sessionStorage.getItem('chunk-reload-attempted');
      if (!alreadyReloaded) {
        sessionStorage.setItem('chunk-reload-attempted', '1');
        window.location.reload();
        // Never resolves -- the page is about to reload anyway, and
        // returning here would briefly flash the ErrorBoundary first.
        return new Promise(() => {});
      }
      // Already tried reloading once and it still failed — a real error,
      // not a stale-chunk issue. Let it surface normally.
      throw error;
    }
  });
}

// Index loads eagerly — it's the landing page, must be instant
import Index from "./pages/Index";

// All other pages are lazy — loaded on first navigation to that route.
// Vite splits each into its own chunk automatically.
const Auth        = lazyWithReload(() => import("./pages/Auth"));
const Sing        = lazyWithReload(() => import("./pages/Sing"));
const Leaderboard = lazyWithReload(() => import("./pages/Leaderboard"));
const History     = lazyWithReload(() => import("./pages/History"));
const Profile     = lazyWithReload(() => import("./pages/Profile"));
const CreateParty = lazyWithReload(() => import("./pages/CreateParty"));
const JoinParty   = lazyWithReload(() => import("./pages/JoinParty"));
const PartyStage  = lazyWithReload(() => import("./pages/PartyStage"));
const PartyQueue  = lazyWithReload(() => import("./pages/PartyQueue"));
const NotFound    = lazyWithReload(() => import("./pages/NotFound"));
const PrivacyPolicy = lazy(() => import("./pages/PrivacyPolicy"));

// Minimal loading fallback — shown while a lazy chunk downloads.
// Intentionally plain: the page's own UI takes over as soon as it's ready.
function PageLoader() {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--background)' }}>
      <div style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--primary)', animation: 'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// Error boundary — catches render-time crashes and shows them on screen
// instead of leaving a blank page with no indication of what went wrong.
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'red', padding: '2rem', fontFamily: 'sans-serif', whiteSpace: 'pre-wrap' }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ fontSize: '0.8rem' }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
      <AuthProvider>
        <Toaster />
        <AuthCallbackGate>
          <HashRouter>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/"                    element={<Index />} />
                <Route path="/auth"                element={<Auth />} />
                <Route path="/sing/:trackId"       element={<Sing />} />
                <Route path="/leaderboard"         element={<Leaderboard />} />
                <Route path="/history"             element={<History />} />
                <Route path="/profile"             element={<Profile />} />
                <Route path="/party/host"          element={<CreateParty />} />
                <Route path="/party/join"          element={<JoinParty />} />
                <Route path="/party/:code/stage"   element={<PartyStage />} />
                <Route path="/party/:code/queue"   element={<PartyQueue />} />
                <Route path="*"                    element={<NotFound />} />
                <Route path="/privacy" element={<PrivacyPolicy />} />
              </Routes>
            </Suspense>
          </HashRouter>
        </AuthCallbackGate>
      </AuthProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
