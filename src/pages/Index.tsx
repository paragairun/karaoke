// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Lyrics dialog popup on Index.tsx: selected track → popup →
//   fetch lyrics with searchMultiple:true → show results → user picks → navigate
//
// v2 — CURRENT: Removed lyrics popup entirely from Index.tsx
//
//   ROOT CAUSE of lyrics not working:
//   1. Index.tsx called fetchLyricsCached({ searchMultiple: true }) expecting
//      { results: [...] } from the edge function.
//   2. The edge function ONLY returns { lyrics: [...] } — no searchMultiple
//      code path exists. So data.results was always undefined.
//   3. fetchedLyrics stayed [] → sessionStorage stored [] → popup blocked user.
//   4. User couldn't click "Start Singing" because lyrics appeared empty.
//
//   FIX: Remove the popup. When user selects a track:
//   - Navigate directly to /sing/:id
//   - Sing.tsx fetches lyrics itself using { lyrics: [...] } shape (correct)
//   - Sing.tsx already handles loading state and lyricsNotFound gracefully
//   This is the "background fetch" architecture already implemented in Sing.tsx.
// =============================================================================

import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mic, Music, Trophy, Sparkles, Loader2, Play, Search, LogOut, User } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalSeparation, prefetchAudio, warmUpHFSpace } from "@/hooks/useVocalSeparation";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";
import { useBackGuard } from "@/hooks/useBackGuard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: "saavn";
  audioUrl: string;
  album?: string;
  language?: string; // "hindi", "punjabi", "english", etc. from Saavn
}

const Index = () => {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, signOut } = useAuth();

  // AI vocal separation (starts in background when track is selected)
  const { isProcessing: isSeparating, progress: separationProgress, separatedAudio, separateVocals, reset: resetSeparation } = useVocalSeparation();
  const separationStartedRef = useRef(false);

  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [trendingSongs, setTrendingSongs] = useState<string[]>([]);
  const [isLoadingTrending, setIsLoadingTrending] = useState(true);

  // ── Back button guard ──────────────────────────────────────────────────
  // If AI separation is running in the background (user picked a song,
  // Modal is working), leaving now would waste that in-progress GPU work.
  // Show a confirmation instead of silently navigating away. Covers the
  // hardware/gesture back button as well as any browser back button.
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const pendingConfirmLeaveRef = useRef<(() => void) | null>(null);

  useBackGuard((confirmLeave) => {
    if (isSeparating) {
      pendingConfirmLeaveRef.current = confirmLeave;
      setShowLeaveConfirm(true);
    } else {
      confirmLeave(); // nothing to protect, let the user go immediately
    }
  });

  // Clear any cached data on homepage load
  useEffect(() => {
    sessionStorage.removeItem("selectedTrack");
    sessionStorage.removeItem("prefetchedLyrics");
    // Warmup moved to handleSearch — fires when user hits the search button,
    // which is the strongest signal that they intend to pick and sing a song.
    // Page-load warmup was wasteful: users who browse and leave in <5 min
    // paid the warmup cost for nothing.
  }, []);

  // Fetch trending Hindi songs on mount with randomized queries
  useEffect(() => {
    const trendingQueries = [
      "new hindi songs 2024",
      "latest bollywood hits",
      "trending hindi songs",
      "top hindi songs 2024",
      "bollywood new releases",
      "hindi chart toppers",
      "latest arijit singh songs",
      "new romantic hindi songs",
      "bollywood party songs 2024",
      "hindi love songs new",
    ];

    const fetchTrending = async () => {
      try {
        // Pick a random query for variety
        const randomQuery = trendingQueries[Math.floor(Math.random() * trendingQueries.length)];

        const { data, error } = await supabase.functions.invoke("search-music", {
          body: { query: randomQuery, limit: 10 },
        });

        if (!error && data?.tracks?.length > 0) {
          // Extract unique song titles (clean them up)
          const titles = data.tracks
            .slice(0, 8)
            .map((t: Track) =>
              t.title
                .replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .replace(/-.*$/, "")
                .trim(),
            )
            .filter((t: string, i: number, arr: string[]) => t.length > 0 && t.length < 25 && arr.indexOf(t) === i)
            .slice(0, 5);

          if (titles.length > 0) {
            setTrendingSongs(titles);
          }
        }
      } catch (error) {
        console.error("Failed to fetch trending:", error);
      } finally {
        setIsLoadingTrending(false);
      }
    };

    fetchTrending();
  }, []);

  const searchWithQuery = async (searchQuery: string) => {
    if (!searchQuery.trim()) return;

    setIsLoading(true);
    setHasSearched(true);

    try {
      const { data, error } = await supabase.functions.invoke("search-music", {
        body: { query: searchQuery.trim() },
      });

      if (error) throw error;

      const fetchedTracks = data?.tracks || [];
      setTracks(fetchedTracks);

      if (fetchedTracks.length > 0) {
        // FIX 2: Prefetch audio for top 3 results immediately when they render,
        // not just on hover. The user is reading results while the download
        // runs in the background — by click time, Step 1 is already done.
        fetchedTracks.slice(0, 3).forEach(track => {
          if (track.audioUrl) prefetchAudio(track.audioUrl);
        });
      }

      if (data?.tracks?.length === 0) {
        toast({
          title: "No tracks found",
          description: "Try a different search term",
        });
      }
    } catch (error) {
      console.error("Search error:", error);
      toast({
        title: "Search failed",
        description: "Please try again later",
        variant: "destructive",
      });
      setTracks([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    // Warm up Modal the instant the user searches — this is the clearest
    // signal of intent to sing. By the time results load (~1s) and the user
    // picks a song (~5-15s), the container has had 6-16s to warm up.
    // Much better than page-load warmup which fires too early and may expire.
    warmUpHFSpace();
    searchWithQuery(query);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  // Navigate directly to sing page — no lyrics popup.
  // Lyrics are fetched by Sing.tsx in the background using the correct
  // { lyrics: [...] } response shape from the edge function.
  const handleSelectTrack = (track: Track) => {
    resetSeparation();
    separationStartedRef.current = false;
    setSelectedTrack(track);

    // Store track in sessionStorage for Sing.tsx to read
    sessionStorage.setItem('selectedTrack', JSON.stringify(track));
    // Prefetch lyrics in parallel with separation — runs BEFORE FLAC
    // download starts, so it gets full bandwidth. Result stored in
    // sessionStorage for Sing.tsx to read instantly on mount.
    sessionStorage.removeItem('prefetchedLyrics');
    fetchLyricsCached({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: parseDurationToSeconds(track.duration),
      language: track.language,
    }).then(result => {
      if (result?.lyrics?.length > 0) {
        sessionStorage.setItem('prefetchedLyrics', JSON.stringify(result.lyrics));
        console.log('[Index] Lyrics prefetched:', result.lyrics.length, 'lines');
      } else {
        console.log('[Index] Lyrics prefetch returned empty');
      }
    }).catch(err => {
      console.warn('[Index] Lyrics prefetch failed:', err?.message || err);
    });

    // Start AI vocal separation in the background
    if (track.audioUrl) {
      separationStartedRef.current = true;
      console.log('[Index] Starting background AI separation for:', track.title);
      separateVocals(track.audioUrl).then((result) => {
        if (result) {
          console.log('[Index] Background AI separation complete:', result.fromCache ? 'from cache' : 'newly processed');
        }
      }).catch((err) => {
        console.error('[Index] Background AI separation failed:', err);
      });
    }

    navigate(`/sing/${track.id}`);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Leave confirmation -- shown when back is pressed while AI separation is running */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Your song is being prepared</AlertDialogTitle>
            <AlertDialogDescription>
              AI is separating the vocals right now. Leaving will cancel this. Are you sure you want to leave?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingConfirmLeaveRef.current?.()}>
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Top-right auth widget */}
      <div className="absolute top-4 right-4 z-20">
        {user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                <Avatar className="h-10 w-10">
                  <AvatarFallback className="gradient-primary text-primary-foreground">
                    {user.email?.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem className="gap-2">
                <User className="h-4 w-4" />
                <span className="truncate">{user.email}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={signOut} className="gap-2 text-destructive">
                <LogOut className="h-4 w-4" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link to="/auth">
            <Button className="gradient-primary shadow-glow">Sign In</Button>
          </Link>
        )}
      </div>

      {/* Hero Section */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 relative overflow-hidden">
        {/* Background effects */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-secondary/20 rounded-full blur-3xl" />
        </div>

        {/* Content */}
        <div className="relative z-10 text-center max-w-4xl mx-auto w-full">
          {/* Logo/Title */}
          <div className="mb-8 flex items-center justify-center gap-3">
            <div className="p-4 rounded-2xl gradient-primary shadow-glow">
              <Mic className="w-10 h-10 text-primary-foreground" />
            </div>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">
            <span className="text-gradient">Karaoke</span>
            <span className="text-foreground"> Party</span>
          </h1>

          <p className="text-xl md:text-2xl text-muted-foreground mb-4 font-medium">Sing Bollywood, Tollywood & More</p>

          <p className="text-muted-foreground mb-8 max-w-2xl mx-auto">
            Your ultimate Indian karaoke experience. Search instrumental tracks, follow synced lyrics, and get scored on
            your vocal performance.
          </p>

          {/* Search Section */}
          <div className="max-w-xl mx-auto mb-8">
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Search for songs... (e.g., 'Tum Hi Ho', 'Kesariya')"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={handleKeyPress}
                className="flex-1 bg-muted border-border h-12 text-base"
              />
              <Button
                onClick={handleSearch}
                disabled={isLoading || !query.trim()}
                size="lg"
                className="gradient-primary text-primary-foreground shadow-glow hover:opacity-90 transition-opacity px-6"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <Music className="w-5 h-5 mr-2" />
                    Start Singing
                  </>
                )}
              </Button>
            </div>

            {/* Trending searches */}
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-2">
                {isLoadingTrending ? "Loading trending..." : "Trending:"}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {isLoadingTrending ? (
                  // Show skeleton placeholders while loading
                  Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-8 w-20 rounded-md bg-muted animate-pulse"
                    />
                  ))
                ) : (
                  trendingSongs.map((term) => (
                    <Button
                      key={term}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery(term);
                        // Search directly with the term instead of relying on stale state
                        searchWithQuery(term);
                      }}
                      className="border-border hover:bg-muted text-xs"
                    >
                      {term}
                    </Button>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Search Results */}
          {hasSearched && (
            <div className="max-w-2xl mx-auto text-left mb-8">
              {isLoading ? (
                <div className="py-8 text-center">
                  <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-3" />
                  <p className="text-muted-foreground">Searching JioSaavn...</p>
                </div>
              ) : tracks.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No results found. Try different keywords.</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
                  <p className="text-muted-foreground text-sm mb-3">
                    Found {tracks.length} track{tracks.length !== 1 ? "s" : ""}
                  </p>

                  {tracks.map((track) => (
                    <div
                      key={track.id}
                      className="group p-3 rounded-xl bg-card border border-border hover:border-primary/50 transition-all cursor-pointer"
                      onClick={() => handleSelectTrack(track)}
                      onMouseEnter={() => {
                        // Prefetch audio on hover for faster separation
                        if (track.audioUrl) {
                          prefetchAudio(track.audioUrl);
                        }
                      }}
                    >
                      <div className="flex items-center gap-3">
                        {/* Thumbnail */}
                        <div className="relative w-20 h-20 md:w-24 md:h-24 rounded-lg overflow-hidden bg-muted shrink-0">
                          {track.thumbnail ? (
                            <img src={track.thumbnail} alt={track.title} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-8 h-8 text-muted-foreground" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-background/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Play className="w-8 h-8 text-primary fill-primary" />
                          </div>
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
                            {track.title}
                          </h3>
                          <p className="text-xs text-muted-foreground truncate">
                            {track.artist} • {track.duration}{track.playCount ? ` • ${track.playCount >= 10000000 ? (track.playCount / 10000000).toFixed(1) + 'Cr' : track.playCount >= 100000 ? (track.playCount / 100000).toFixed(1) + 'L' : track.playCount >= 1000 ? (track.playCount / 1000).toFixed(0) + 'K' : track.playCount}` : ''}
                          </p>
                        </div>

                        {/* Action */}
                        <Button
                          size="sm"
                          className="gradient-primary text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-xs"
                        >
                          Sing
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Language badges */}
          {!hasSearched && (
            <div className="flex flex-wrap justify-center gap-2 mb-8">
              {["Hindi", "Marathi", "Gujarati", "Punjabi", "Tamil", "Telugu", "Malayalam"].map((lang) => (
                <span key={lang} className="language-badge text-muted-foreground">
                  {lang}
                </span>
              ))}
            </div>
          )}

          {/* Secondary CTA */}
          <div className="flex justify-center">
            <Link to="/leaderboard">
              <Button size="lg" variant="outline" className="px-8 py-6 text-lg border-border hover:bg-muted">
                <Trophy className="w-5 h-5 mr-2" />
                Leaderboard
              </Button>
            </Link>
          </div>
        </div>
      </div>
{/* Features Section */}
      <div className="py-16 px-4 border-t border-border">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">
          <FeatureCard
            icon={<Music className="w-8 h-8" />}
            title="Vast Music Library"
            description="Search thousands of Bollywood, Tollywood, and regional instrumental tracks from Gaana & JioSaavn"
          />
          <FeatureCard
            icon={<Sparkles className="w-8 h-8" />}
            title="Real-time Scoring"
            description="Get scored on pitch accuracy, rhythm, and diction as you sing with visual feedback"
          />
          <FeatureCard
            icon={<Trophy className="w-8 h-8" />}
            title="Compete & Share"
            description="Track your performance history, climb the leaderboard, and challenge friends"
          />
        </div>
      </div>

      {/* Footer */}
      <footer className="py-6 px-4 border-t border-border text-center text-muted-foreground text-sm">
        <p>Built with ❤️ for Indian music lovers by ajparag@gmail.com</p>
      </footer>
    </div>
  );
};

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const FeatureCard = ({ icon, title, description }: FeatureCardProps) => (
  <div className="p-6 rounded-xl bg-card border border-border hover:border-primary/50 transition-colors">
    <div className="w-14 h-14 rounded-xl gradient-primary flex items-center justify-center text-primary-foreground mb-4">
      {icon}
    </div>
    <h3 className="text-xl font-semibold mb-2">{title}</h3>
    <p className="text-muted-foreground">{description}</p>
  </div>
);

export default Index;
