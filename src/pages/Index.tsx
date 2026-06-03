import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Mic, Music, Trophy, Sparkles, Loader2, Play, Search, Edit2, Check, LogOut, User } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalSeparation, prefetchAudio, warmUpHFSpace } from "@/hooks/useVocalSeparation";
import { useAuth } from "@/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";
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
}

interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

interface LyricsSearchResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  lyrics: LyricLine[];
  synced: boolean;
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

  // Lyrics dialog state
  const [lyricsDialogOpen, setLyricsDialogOpen] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [lyricsSearchTitle, setLyricsSearchTitle] = useState("");
  const [lyricsSearchArtist, setLyricsSearchArtist] = useState("");
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [fetchedLyrics, setFetchedLyrics] = useState<LyricLine[]>([]);
  const [lyricsSearchResults, setLyricsSearchResults] = useState<LyricsSearchResult[]>([]);
  const [selectedLyricsId, setSelectedLyricsId] = useState<string>("");
  const [trendingSongs, setTrendingSongs] = useState<string[]>([]);
  const [isLoadingTrending, setIsLoadingTrending] = useState(true);

  // Clear any cached data on homepage load
  useEffect(() => {
    sessionStorage.removeItem("selectedTrack");
    sessionStorage.removeItem("prefetchedLyrics");
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

      setTracks(data?.tracks || []);
      
      // Start warming up HF space when search results arrive
      if (data?.tracks?.length > 0) {
        warmUpHFSpace();
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
    searchWithQuery(query);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  // Open lyrics dialog when user selects a track
  const handleSelectTrack = (track: Track) => {
    // Reset separation state for new track selection
    resetSeparation();
    separationStartedRef.current = false;
    
    setSelectedTrack(track);
    setFetchedLyrics([]);
    setLyricsSearchResults([]);
    setSelectedLyricsId("");

    // Pre-fill with cleaned track info
    const cleanTitle =
      track.title
        ?.replace(/\(.*?\)/g, "")
        ?.replace(/\[.*?\]/g, "")
        ?.replace(/karaoke|instrumental|lyrics|official|video|audio|hd|4k/gi, "")
        ?.trim() || "";

    // Extract first artist name (artists may be comma-separated)
    const firstArtist = track.artist?.split(',')[0]?.trim() || "";

    setLyricsSearchTitle(cleanTitle);
    setLyricsSearchArtist(firstArtist);
    setLyricsDialogOpen(true);

    // Start AI vocal separation in the background (will be cached in IndexedDB)
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

    // Auto-fetch lyrics with multiple results using first artist for better LRCLIB matches
    fetchLyrics(cleanTitle, firstArtist, track.album, track.duration);
  };

  // Reset separation state when dialog closes
  const handleDialogClose = (open: boolean) => {
    if (!open) {
      separationStartedRef.current = false;
      resetSeparation();
    }
    setLyricsDialogOpen(open);
  };

  const fetchLyrics = async (title: string, artist: string, album?: string, durationStr?: string) => {
    setIsSearchingLyrics(true);
    setLyricsSearchResults([]);
    setSelectedLyricsId("");
    try {
      const data = await fetchLyricsCached({
        title,
        artist,
        album,
        duration: parseDurationToSeconds(durationStr),
        searchMultiple: true,
      });
      if (data?.results && data.results.length > 0) {
        setLyricsSearchResults(data.results);
        setSelectedLyricsId(String(data.results[0].id));
        setFetchedLyrics(data.results[0].lyrics);
      } else {
        setFetchedLyrics([]);
        toast({
          title: "Lyrics not found",
          description: "Try editing the title/artist and search again",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to fetch lyrics:", error);
      setFetchedLyrics([]);
      toast({
        title: "Lyrics not found",
        description: "Request timed out — try editing the title and search again",
        variant: "destructive",
      });
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  const handleLyricsSearch = async () => {
    if (!lyricsSearchTitle.trim()) {
      toast({ title: "Please enter a song title", variant: "destructive" });
      return;
    }
    await fetchLyrics(lyricsSearchTitle.trim(), lyricsSearchArtist.trim());
  };

  const handleStartSinging = () => {
    if (!selectedTrack) return;

    // Store track and lyrics in sessionStorage
    sessionStorage.setItem("selectedTrack", JSON.stringify(selectedTrack));
    sessionStorage.setItem("prefetchedLyrics", JSON.stringify(fetchedLyrics));

    setLyricsDialogOpen(false);
    navigate(`/sing/${selectedTrack.id}`);
  };

  const handleSkipLyrics = () => {
    if (!selectedTrack) return;

    // Store track without lyrics
    sessionStorage.setItem("selectedTrack", JSON.stringify(selectedTrack));
    sessionStorage.removeItem("prefetchedLyrics");

    setLyricsDialogOpen(false);
    navigate(`/sing/${selectedTrack.id}`);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
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
                            {track.artist} • {track.duration}
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

      {/* Lyrics Search Dialog */}
      <Dialog open={lyricsDialogOpen} onOpenChange={handleDialogClose}>
        <DialogContent
          className="sm:max-w-lg bg-card max-h-[80vh] overflow-hidden flex flex-col"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Setup Lyrics</DialogTitle>
            <DialogDescription>
              Search for synced lyrics before you start singing. You can skip this step if you prefer.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 flex-1 overflow-y-auto">
            {selectedTrack && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
                {selectedTrack.thumbnail && (
                  <img
                    src={selectedTrack.thumbnail}
                    alt={selectedTrack.title}
                    className="w-12 h-12 rounded-lg object-cover"
                    loading="lazy"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{selectedTrack.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{selectedTrack.artist}</p>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="lyrics-title">Song Title</Label>
              <Input
                id="lyrics-title"
                placeholder="e.g., Tum Hi Ho"
                value={lyricsSearchTitle}
                onChange={(e) => setLyricsSearchTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLyricsSearch()}
                autoFocus={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lyrics-artist">Artist (optional)</Label>
              <Input
                id="lyrics-artist"
                placeholder="e.g., Arijit Singh"
                value={lyricsSearchArtist}
                onChange={(e) => setLyricsSearchArtist(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLyricsSearch()}
              />
            </div>

            <Button
              onClick={handleLyricsSearch}
              disabled={isSearchingLyrics || !lyricsSearchTitle.trim()}
              variant="outline"
              className="w-full"
            >
              {isSearchingLyrics ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Search Lyrics
                </>
              )}
            </Button>

            {/* Search Results */}
            {lyricsSearchResults.length > 0 && (
              <div className="space-y-2">
                <Label>Select Lyrics ({lyricsSearchResults.length} options)</Label>
                <RadioGroup
                  value={selectedLyricsId}
                  onValueChange={(value) => {
                    setSelectedLyricsId(value);
                    const selected = lyricsSearchResults.find((r) => String(r.id) === value);
                    if (selected) setFetchedLyrics(selected.lyrics);
                  }}
                  className="space-y-2"
                >
                  {lyricsSearchResults.map((result) => (
                    <label
                      key={result.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedLyricsId === String(result.id)
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <RadioGroupItem value={String(result.id)} className="mt-1" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{result.trackName}</p>
                        <p className="text-sm text-muted-foreground truncate">{result.artistName}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {result.albumName && (
                            <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                              {result.albumName}
                            </span>
                          )}
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded ${
                              result.synced ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {result.synced ? "Synced" : "Plain"}
                          </span>
                        </div>
                      </div>
                      {selectedLyricsId === String(result.id) && <Check className="w-4 h-4 text-primary mt-1" />}
                    </label>
                  ))}
                </RadioGroup>
              </div>
            )}

            {/* Lyrics status */}
            {fetchedLyrics.length > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 text-primary">
                <Check className="w-4 h-4" />
                <span className="text-sm font-medium">{fetchedLyrics.length} lines ready</span>
              </div>
            )}

            {/* AI Separation progress */}
            {isSeparating && separationProgress && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{separationProgress}</span>
              </div>
            )}
            {!isSeparating && separatedAudio && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-score-perfect/10 text-score-perfect">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm font-medium">
                  AI instrumental ready {separatedAudio.fromCache ? '(cached)' : ''}
                </span>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={handleSkipLyrics} className="w-full sm:w-auto">
              Skip Lyrics
            </Button>
            <Button onClick={handleStartSinging} className="gradient-primary text-primary-foreground w-full sm:w-auto">
              <Mic className="w-4 h-4 mr-2" />
              Start Singing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
