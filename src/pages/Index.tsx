// =============================================================================
// Index.tsx — Home page
// CHANGELOG
// v1 — Original Lovable output. Lyrics popup, broken searchMultiple path.
// v2 — Removed lyrics popup. Direct navigation to Sing.tsx.
// v3 — CURRENT: Full rewrite.
//   - Dead imports removed (prefetchAudio removed — was a no-op)
//   - warmUpModal renamed from warmUpHFSpace
//   - Track selection checks IndexedDB first, only warms Modal on cache miss
//   - Trending logic extracted to useTrending hook inline
//   - UI redesigned: energetic hero, 2x2 mode grid, always-visible Sing button
//   - handleSingSoloClick and handleSelectTrack deduplicated
//     (both cleared activePartyContext — now done once in handleSelectTrack)
//   - prefetchAudio on onMouseEnter removed (was a no-op wrapper)
//   - source field widened to 'saavn' | 'youtube' (Gaana also returns 'saavn')
// =============================================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Music, Loader2, Search, LogOut, User, Sun, Moon, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { useBackGuard } from "@/hooks/useBackGuard";
import { useVocalSeparation, warmUpModal } from "@/hooks/useVocalSeparation";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";

// ─── Types ────────────────────────────────────────────────────────────────────

// One width for every section (header, hero, search, cards, results) so they
// line up on phones, laptops and TVs. Literal class names for Tailwind.
const CONTAINER = "mx-auto w-full max-w-[72rem] 2xl:max-w-[96rem] px-4 sm:px-6";

// Where each search result comes from. Class names are written out in full
// (Tailwind only generates classes it can see in the source).
const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  saavn:   { label: "JioSaavn", className: "border-teal-500/40 text-teal-600 dark:text-teal-400" },
  gaana:   { label: "Gaana",    className: "border-red-500/40 text-red-600 dark:text-red-400" },
  youtube: { label: "YouTube",  className: "border-zinc-500/40 text-zinc-600 dark:text-zinc-400" },
};

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: "saavn" | "gaana" | "youtube";
  audioUrl: string;
  album?: string;
  language?: string;
  releaseDate?: string;
  year?: number;
  playCount?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPlayCount(n: number): string {
  if (n >= 10_000_000) return (n / 10_000_000).toFixed(1) + 'Cr';
  if (n >= 100_000)    return (n / 100_000).toFixed(1) + 'L';
  if (n >= 1_000)      return Math.round(n / 1_000) + 'K';
  return String(n);
}

function cleanTitle(title: string): string {
  return title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/-.*$/, '').trim();
}

// ─── Component ────────────────────────────────────────────────────────────────

const Index = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, signOut } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const { isProcessing: isSeparating, separateVocals } = useVocalSeparation();

  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [trendingSongs, setTrendingSongs] = useState<string[]>([]);
  const [isLoadingTrending, setIsLoadingTrending] = useState(true);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingConfirmLeaveRef = useRef<(() => void) | null>(null);

  // Guard back button while separation is in progress
  useBackGuard((confirmLeave) => {
    if (isSeparating) {
      pendingConfirmLeaveRef.current = confirmLeave;
      setShowLeaveConfirm(true);
    } else {
      confirmLeave();
    }
  });

  // ── Trending songs ──────────────────────────────────────────────────────────
  useEffect(() => {
    const currentYear = new Date().getFullYear();
    const queries = [
      `new hindi songs ${currentYear}`,
      `top hindi songs ${currentYear}`,
      'hindi chart toppers',
      'latest arijit singh songs',
      `hindi love songs ${currentYear}`,
    ];

    const fetchTrending = async () => {
      try {
        const picks = [...queries].sort(() => Math.random() - 0.5).slice(0, 3);
        const results = await Promise.allSettled(
          picks.map(q => supabase.functions.invoke('search-music', { body: { query: q } }))
        );

        const seen = new Set<string>();
        const all: Track[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled' && !r.value.error) {
            for (const t of (r.value.data?.tracks ?? []) as Track[]) {
              if (!seen.has(t.id)) { seen.add(t.id); all.push(t); }
            }
          }
        }

        // Prefer recent tracks (last 90 days or current/previous year)
        const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
        const recent = all.filter(t => {
          if (t.releaseDate && !isNaN(new Date(t.releaseDate).getTime()))
            return new Date(t.releaseDate).getTime() >= ninetyDaysAgo;
          return t.year != null && t.year >= currentYear - 1;
        });

        const pool = recent.length > 0 ? recent : all;
        const titles = pool
          .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
          .map(t => cleanTitle(t.title))
          .filter((t, i, arr) => t.length > 0 && t.length < 25 && arr.indexOf(t) === i)
          .slice(0, 4);

        if (titles.length > 0) setTrendingSongs(titles);
      } catch (err) {
        console.warn('[Index] Trending fetch failed:', err);
      } finally {
        setIsLoadingTrending(false);
      }
    };

    fetchTrending();
  }, []);

  // ── Search ──────────────────────────────────────────────────────────────────
  const searchWithQuery = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setIsLoading(true);
    setIsLoadingMore(false);
    setHasSearched(true);
    setTracks([]);

    const seenIds = new Set<string>();
    let jioSaavnCount = 0;
    let gaanaCount = 0;
    let firstResultShown = false;

    // Appends new results to whatever's already on screen — never replaces
    // or re-sorts the existing list, so nothing jumps around while the
    // user is looking at it. Whichever source answers first is what
    // appears first.
    const appendTracks = (newTracks: Track[]) => {
      const filtered = newTracks.filter((t: Track) => !seenIds.has(t.id));
      filtered.forEach((t: Track) => seenIds.add(t.id));
      if (filtered.length === 0) return;
      setTracks(prev => [...prev, ...filtered]);
      if (!firstResultShown) {
        firstResultShown = true;
        setIsLoading(false); // clear the spinner the instant ANY source responds
      }
    };

    try {
      // JioSaavn and Gaana fired as two INDEPENDENT calls (not one call
      // that internally waits for both) — each renders the moment its own
      // response lands. Previously both were bundled into a single tier1
      // call that blocked on whichever was slower; if Gaana's Render
      // backend has cold-started after being idle, that alone could add
      // 30-50s to every search regardless of how fast JioSaavn answered.
      await Promise.all([
        supabase.functions.invoke('search-music', { body: { query: trimmed, tier: 'jiosaavn' } })
          .then(({ data, error }) => {
            if (error) { console.warn('[Index] JioSaavn search failed (non-fatal):', error); return; }
            const tracks: Track[] = data?.tracks ?? [];
            jioSaavnCount = tracks.length;
            appendTracks(tracks);
          })
          .catch(err => console.warn('[Index] JioSaavn search failed (non-fatal):', err)),

        supabase.functions.invoke('search-music', { body: { query: trimmed, tier: 'gaana' } })
          .then(({ data, error }) => {
            if (error) { console.warn('[Index] Gaana search failed (non-fatal):', error); return; }
            const tracks: Track[] = data?.tracks ?? [];
            gaanaCount = tracks.length;
            appendTracks(tracks);
          })
          .catch(err => console.warn('[Index] Gaana search failed (non-fatal):', err)),
      ]);

      setIsLoading(false); // covers the case where neither source returned anything

      // Same "fewer than 5 combined results" threshold used server-side
      // for the legacy path — tested in search-fallback-threshold.test.ts.
      // Duplicated here (not imported) since client and edge function are
      // different runtimes; kept in sync manually.
      const MIN_RESULTS_BEFORE_YOUTUBE = 5;
      if (jioSaavnCount + gaanaCount < MIN_RESULTS_BEFORE_YOUTUBE) {
        setIsLoadingMore(true);
        try {
          const { data, error } = await supabase.functions.invoke('search-music', {
            body: { query: trimmed, tier: 'tier2' },
          });
          if (!error && data?.tracks?.length) {
            appendTracks(data.tracks);
          }
        } catch (err) {
          console.warn('[Index] Tier 2 (YouTube) search failed (non-fatal):', err);
        } finally {
          setIsLoadingMore(false);
        }
      }
    } catch (err) {
      console.error('[Index] Search failed:', err);
      toast({ title: 'Search failed', description: 'Please try again', variant: 'destructive' });
      setTracks([]);
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [toast]);

  const handleSearch = useCallback(() => {
    searchWithQuery(query);
  }, [query, searchWithQuery]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  // ── Track selection ─────────────────────────────────────────────────────────
  const handleSelectTrack = useCallback((track: Track) => {
    // Store track for Sing.tsx to consume
    sessionStorage.setItem('selectedTrack', JSON.stringify(track));
    // Clear stale party context — this is a fresh solo session
    sessionStorage.removeItem('activePartyContext');
    sessionStorage.removeItem('prefetchedLyrics');

    // Prefetch lyrics in parallel — fire and forget
    fetchLyricsCached({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: parseDurationToSeconds(track.duration),
      language: track.language,
    }).then(result => {
      if (result?.lyrics?.length > 0)
        sessionStorage.setItem('prefetchedLyrics', JSON.stringify(result.lyrics));
    }).catch(() => {/* non-fatal */});

    // Caching now lives server-side (Supabase Storage, checked inside the
    // separate-vocals edge function) — there's no cheap local check anymore
    // to decide whether to skip the warmup ping. Fire both unconditionally;
    // the warmup ping is lightweight and harmless even on a Storage cache
    // hit (the edge function just won't end up needing Modal at all).
    warmUpModal();
    // songMeta lets the edge function compute a canonical cache key
    // (title+artist+duration) so this song hits the shared Storage cache
    // even if it was already separated from a different source earlier.
    separateVocals(track.audioUrl, 'fast', track.id, {
      title: track.title,
      artist: track.artist,
      durationSeconds: parseDurationToSeconds(track.duration) ?? 0,
    });

    navigate(`/sing/${track.id}`);
  }, [navigate, separateVocals]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">

      {/* Leave confirmation while separation is in progress */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Song is being prepared</AlertDialogTitle>
            <AlertDialogDescription>
              AI is separating the vocals right now. Leaving will cancel this.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingConfirmLeaveRef.current?.()}>
              Leave anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Header ── */}
      <header className="border-b border-border shrink-0">
        <div className={`${CONTAINER} flex items-center justify-between py-3`}>
        <Link to="/" className="flex items-center gap-2">
          <img src="/app-icon.png" alt="KaraokeParty" className="w-8 h-8 rounded-lg" />
          {/* Text hidden below 360px (the logo stays) so the header fits the narrowest phones. */}
          <span className="text-base font-semibold max-[359px]:hidden">KaraokeParty</span>
        </Link>
        <div className="flex items-center gap-1">
          {/* Plain <a>, not React Router's <Link>: /blog/ is a set of static
              HTML pages (public/blog/, for SEO), not an app route, so it needs
              a real page navigation. */}
          <a
            href="/blog/"
            className="hidden sm:inline-flex items-center h-8 px-3 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Blog
          </a>
          {/* Icon-only on phones: the full label collided with the site name below 640px. */}
          <Link
            to="/leaderboard"
            aria-label="Leaderboard"
            title="Leaderboard"
            className="inline-flex items-center gap-1 h-8 px-2 sm:px-3 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Trophy className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className="hidden sm:inline">Leaderboard</span>
          </Link>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="h-8 w-8 rounded-full">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 rounded-full p-0">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="gradient-primary text-primary-foreground text-xs">
                      {user.email?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem className="gap-2 text-xs text-muted-foreground" disabled>
                  <User className="h-3 w-3" />
                  <span className="truncate">{user.email}</span>
                </DropdownMenuItem>
                <Link to="/profile">
                  <DropdownMenuItem className="gap-2">
                    <User className="h-4 w-4" /> Profile
                  </DropdownMenuItem>
                </Link>
                <DropdownMenuItem onClick={signOut} className="gap-2 text-destructive">
                  <LogOut className="h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link to="/auth">
              <Button size="sm" className="gradient-primary text-primary-foreground h-8 text-xs rounded-full px-4">
                Sign in
              </Button>
            </Link>
          )}
        </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <div className="shrink-0 border-b border-border">
       <div className={`${CONTAINER} pt-5 pb-4 md:pt-8 md:pb-6`}>
        <h1 className="text-2xl md:text-3xl font-bold leading-tight mb-1">
          Sing any song.
          <br />
          <span className="text-gradient">AI scores you live.</span>
        </h1>
        <p className="text-sm md:text-base text-muted-foreground mb-4 leading-snug">
          AI removes vocals in seconds. Lyrics light up. Scored on accuracy, flow and expression.
        </p>

        {/* Search */}
        <div className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search a song to sing..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-9 h-11 rounded-full bg-muted border-border text-sm"
            />
          </div>
          <Button
            onClick={handleSearch}
            disabled={isLoading || !query.trim()}
            size="icon"
            className="gradient-primary text-primary-foreground h-11 w-11 rounded-full shrink-0"
          >
            {isLoading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Search className="w-4 h-4" />}
          </Button>
        </div>

        {/* Trending tags */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {isLoadingTrending ? 'Loading...' : 'Trending'}
          </span>
          {isLoadingTrending
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-6 w-16 rounded-full bg-muted animate-pulse" />
              ))
            : trendingSongs.map(term => (
                <button
                  key={term}
                  onClick={() => { setQuery(term); searchWithQuery(term); }}
                  className="text-xs h-7 px-3 rounded-full border border-border bg-background hover:bg-muted text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {term}
                </button>
              ))}
        </div>
       </div>
      </div>

      {/* ── Mode grid (shown when no search results) ── */}
      {!hasSearched && (
        <div className={`${CONTAINER} grid grid-cols-2 gap-3 py-4 shrink-0`}>
          {[
            // Full class names written out so Tailwind generates them
            // (a runtime-built `hover:${color}` is never generated).
            { to: '/party/host', icon: '🎉', label: 'Host a party', sub: 'Start the stage', hover: 'hover:bg-purple-500/10' },
            { to: '/party/join', icon: '👥', label: 'Join a party', sub: 'Enter a code', hover: 'hover:bg-green-500/10' },
          ].map(({ to, icon, label, sub, hover }) => (
            <Link key={label} to={to} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <div className={`h-full p-4 md:p-5 flex flex-col gap-2 rounded-xl border border-border bg-background ${hover} transition-colors cursor-pointer`}>
                <span className="text-2xl">{icon}</span>
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{sub}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* ── Results ── */}
      <div className="flex-1 overflow-y-auto">
        <div className={`${CONTAINER} py-3`}>
          {isLoading ? (
            <div className="py-10 text-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Searching...</p>
            </div>
          ) : hasSearched && tracks.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-10">
              No results. Try different keywords.
            </p>
          ) : tracks.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                {tracks.length} result{tracks.length !== 1 ? 's' : ''}
              </p>
              {/* 1 column on phones, 2 on tablets/laptops, 3 on very wide
                  screens. Each result is one button, so keyboards and TV
                  remotes (D-pad + OK) can move through results and select. */}
              <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-x-4 gap-y-1">
                {tracks.map(track => (
                  <button
                    type="button"
                    key={track.id}
                    data-result-card
                    title={`${track.title} — ${track.artist}`}
                    className="w-full min-w-0 flex items-center gap-3 p-2 rounded-xl text-left hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => handleSelectTrack(track)}
                  >
                    <div className="relative w-12 h-12 md:w-14 md:h-14 rounded-lg overflow-hidden bg-muted shrink-0">
                      {track.thumbnail
                        ? <img src={track.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                        : <div className="w-full h-full flex items-center justify-center">
                            <Music className="w-5 h-5 text-muted-foreground" />
                          </div>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{track.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        <span className={`inline-block align-middle mr-1.5 px-1.5 py-px rounded border text-[0.625rem] leading-tight font-medium ${SOURCE_BADGE[track.source]?.className ?? SOURCE_BADGE.saavn.className}`}>
                          {SOURCE_BADGE[track.source]?.label ?? track.source}
                        </span>
                        {track.artist}
                        {track.duration ? ` · ${track.duration}` : ''}
                        {track.playCount ? ` · ${formatPlayCount(track.playCount)}` : ''}
                      </p>
                    </div>
                    <span className="gradient-primary text-primary-foreground shrink-0 text-xs font-medium h-8 rounded-full px-4 inline-flex items-center">
                      Sing
                    </span>
                  </button>
                ))}
              </div>
              {isLoadingMore && (
                <div className="py-4 text-center">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Looking for more...</p>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default Index;
