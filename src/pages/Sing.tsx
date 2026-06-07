import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Play, Pause, Mic, MicOff, RotateCcw, Save, Volume2, VolumeX, Edit2, Search, Music, Check, Loader2 } from "lucide-react";
import { VocalsIcon } from "@/components/icons/VocalsIcon";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalsComparison } from "@/hooks/useVocalsComparison";
import { useAuth } from "@/hooks/useAuth";
import { Slider } from "@/components/ui/slider";
import { useVocalSeparation } from "@/hooks/useVocalSeparation";
import { ScoreSubmissionDialog } from "@/components/karaoke/ScoreSubmissionDialog";
import { AudioDebugOverlay } from "@/components/karaoke/AudioDebugOverlay";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn';
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

const Sing = () => {
  const { trackId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, session } = useAuth();
  
  const [track, setTrack] = useState<Track | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [totalScore, setTotalScore] = useState(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const [showScoreSubmission, setShowScoreSubmission] = useState(false);
  const preEndTriggeredRef = useRef(false);
  
  // Lyrics search dialog state
  const [lyricsDialogOpen, setLyricsDialogOpen] = useState(false);
  const [lyricsSearchTitle, setLyricsSearchTitle] = useState("");
  const [lyricsSearchArtist, setLyricsSearchArtist] = useState("");
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [lyricsSearchResults, setLyricsSearchResults] = useState<LyricsSearchResult[]>([]);
  const [selectedLyricsId, setSelectedLyricsId] = useState<string>("");
  
  // Main instrumental audio
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Vocals audio (plays at 50% volume when enabled)
  const vocalsAudioRef = useRef<HTMLAudioElement | null>(null);
  const timeSyncRafRef = useRef<number | null>(null);
  const scoreAccumulatorRef = useRef({ pitch: 0, rhythm: 0, technique: 0, count: 0 });

  // New scoring weights: Pitch 40%, Rhythm 30%, Technique 30% (no diction)
  const SCORE_WEIGHTS = useRef({ pitch: 0.4, rhythm: 0.3, technique: 0.3 }).current;

  // AI-based vocal separation - loads from IndexedDB cache (separation happens on Index page)
  const {
    isProcessing: isLoadingFromCache,
    progress: cacheProgress,
    separatedAudio,
    separateVocals: loadFromCache,
  } = useVocalSeparation();

  // Vocals comparison hook - compares user singing with AI-separated vocals
  const {
    isActive: isMicActive,
    metrics,
    error: micError,
    startAnalysis,
    stopAnalysis,
    resetScores,
  } = useVocalsComparison({
    vocalsUrl: separatedAudio?.vocalsUrl,
    currentTime,
    isPlaying,
  });

  const showAudioDebug = new URLSearchParams(window.location.search).get('debugAudio') === '1';

  // Vocals volume control (0-100, default 30%)
  const [vocalsVolume, setVocalsVolume] = useState(30);
  const [vocalsEnabled, setVocalsEnabled] = useState(true);

  // Load track and pre-fetched lyrics from session storage
  useEffect(() => {
    const stored = sessionStorage.getItem('selectedTrack');
    if (stored) {
      const parsed = JSON.parse(stored);
      setTrack(parsed);
      
      // Check for pre-fetched lyrics first
      const prefetchedLyrics = sessionStorage.getItem('prefetchedLyrics');
      if (prefetchedLyrics) {
        try {
          const parsedLyrics = JSON.parse(prefetchedLyrics);
          if (parsedLyrics && parsedLyrics.length > 0) {
            setLyrics(parsedLyrics);
          } else {
            fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration);
          }
        } catch {
          fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration);
        }
        // Clean up after use
        sessionStorage.removeItem('prefetchedLyrics');
      } else {
        fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration);
      }
    } else {
      navigate('/');
    }
  }, [trackId, navigate, toast]);

  // TEST MODE: ?testPlayer=1 bypasses HF separation and uses original AAC for player testing
  const isTestPlayerMode = new URLSearchParams(window.location.search).has('testPlayer');

  // Load separated audio from IndexedDB cache (separation already happened on Index page).
  // IMPORTANT: Only call once per track to avoid duplicate processing.
  const separationTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (isTestPlayerMode) return; // Skip separation in test mode
    if (track?.audioUrl && !separatedAudio && !isLoadingFromCache) {
      if (separationTriggeredRef.current === track.audioUrl) return;
      separationTriggeredRef.current = track.audioUrl;

      loadFromCache(track.audioUrl).then((result) => {
        if (result) {
          console.log('[sing] Loaded separated audio:', result.fromCache ? 'cached' : 'processed');
        }
      });
    }
  }, [track?.audioUrl, separatedAudio, isLoadingFromCache, loadFromCache, isTestPlayerMode]);

  // Initialize HTML5 Audio Player - Demucs instrumental or fallback to original
  useEffect(() => {
    if (!track?.audioUrl) return;

    let isMounted = true;
    setIsLoadingAudio(true);
    setIsPlayerReady(false);
    setDuration(0);
    setCurrentTime(0);

    const audio = new Audio();
    audioRef.current = audio;

    // Set audio session type to 'playback' for proper volume button behavior on mobile
    if ('audioSession' in navigator && (navigator as any).audioSession) {
      try {
        (navigator as any).audioSession.type = 'playback';
        console.log('[audio] Set audio session type to playback');
      } catch (e) {
        console.log('[audio] Could not set audio session type:', e);
      }
    }

    const stopTimeSync = () => {
      if (timeSyncRafRef.current != null) {
        cancelAnimationFrame(timeSyncRafRef.current);
        timeSyncRafRef.current = null;
      }
    };

    const startTimeSync = () => {
      if (timeSyncRafRef.current != null) return;
      const tick = () => {
        if (!isMounted || !audioRef.current) return;
        setCurrentTime(audioRef.current.currentTime);
        timeSyncRafRef.current = requestAnimationFrame(tick);
      };
      timeSyncRafRef.current = requestAnimationFrame(tick);
    };

    let objectUrlToRevoke: string | null = null;

    const markReady = (reason: string) => {
      console.log(`[sing] player ready via ${reason}, duration:`, audio.duration, 'readyState:', audio.readyState);
      if (!isMounted) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      setIsPlayerReady(true);
      setIsLoadingAudio(false);
    };

    const applyAudioBlob = (blob: Blob) => {
      const playableBlob = blob.type === 'audio/mp4' ? blob : new Blob([blob], { type: 'audio/mp4' });
      const blobUrl = URL.createObjectURL(playableBlob);
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      objectUrlToRevoke = blobUrl;
      audio.src = blobUrl;
      audio.load();
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) markReady('blob-readyState');
    };

    audio.crossOrigin = "anonymous";
    audio.preload = "auto";

    const onLoadedMetadata = () => {
      console.log('[sing] loadedmetadata fired, duration:', audio.duration);
      markReady('loadedmetadata');
    };

    const onCanPlay = () => markReady('canplay');
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('canplaythrough', () => console.log('[sing] canplaythrough fired'));
    audio.addEventListener('progress', () => {
      if (audio.buffered.length > 0) {
        console.log('[sing] progress: buffered', Math.round(audio.buffered.end(0)), 's');
      }
    });
    audio.addEventListener('stalled', () => console.log('[sing] stalled'));
    audio.addEventListener('waiting', () => console.log('[sing] waiting'));
    audio.addEventListener('suspend', () => console.log('[sing] suspend'));

    const onTimeUpdate = () => {
      if (isMounted) setCurrentTime(audio.currentTime);
    };

    const onPlay = () => {
      if (!isMounted) return;
      setIsPlaying(true);
      startTimeSync();
    };

    const onPause = () => {
      if (!isMounted) return;
      setIsPlaying(false);
      stopTimeSync();
    };

    const onEnded = () => {
      if (isMounted) {
        setIsPlaying(false);
        stopTimeSync();
        // FIX: only show results if score submission dialog is not already open.
        // Without this guard, both overlays appear simultaneously when the song
        // ends while the submission dialog is still visible.
        if (!preEndTriggeredRef.current) setShowResults(true);
      }
    };

    const onError = () => {
      console.error('Audio error:', audio.error);
      if (isMounted) {
        setIsLoadingAudio(false);
        toast({
          title: "Audio error",
          description: "Failed to load. Try another song.",
          variant: "destructive",
        });
      }
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    if (separatedAudio?.instrumentalUrl) {
      audio.src = separatedAudio.instrumentalUrl;
      audio.load();
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) markReady('separated-readyState');
      console.log('[sing] Using AI-separated instrumental');
    } else if (isTestPlayerMode && track?.audioUrl) {
      console.log('[sing] Downloading original audio as blob for test player mode...');
      fetch(track.audioUrl)
        .then(r => {
          if (!r.ok) throw new Error(`Direct audio fetch failed: ${r.status}`);
          console.log('[sing] Audio fetch response:', r.status, r.headers.get('content-type'));
          return r.blob();
        })
        .then(blob => {
          if (!isMounted) return;
          console.log('[sing] Audio blob ready:', Math.round(blob.size / 1024), 'KB, type:', blob.type);
          applyAudioBlob(blob);
        })
        .catch(err => {
          console.error('[sing] Audio download failed, trying proxy...', err);
          if (!isMounted) return;
          const proxyUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/proxy-audio?url=${encodeURIComponent(track.audioUrl)}`;
          fetch(proxyUrl, {
            headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
          }).then(r => {
            if (!r.ok) throw new Error(`Proxy audio fetch failed: ${r.status}`);
            return r.blob();
          }).then(blob => {
            if (!isMounted) return;
            console.log('[sing] Proxy blob ready:', Math.round(blob.size / 1024), 'KB');
            applyAudioBlob(blob);
          }).catch(e => {
            console.error('[sing] Proxy also failed:', e);
            if (isMounted) {
              setIsLoadingAudio(false);
              toast({ title: "Audio error", description: "Failed to load audio.", variant: "destructive" });
            }
          });
        });
    } else {
      setIsLoadingAudio(false);
    }

    return () => {
      isMounted = false;
      stopTimeSync();
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.pause();
      audio.src = '';
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      audioRef.current = null;
      stopAnalysis();
    };
  }, [track?.audioUrl, toast, stopAnalysis, separatedAudio?.instrumentalUrl, isTestPlayerMode, session?.access_token]);

  // Setup vocals audio when separated audio is available
  useEffect(() => {
    if (!separatedAudio?.vocalsUrl) {
      vocalsAudioRef.current = null;
      return;
    }

    const vocalsAudio = new Audio();
    vocalsAudio.crossOrigin = "anonymous";
    vocalsAudio.src = separatedAudio.vocalsUrl;
    vocalsAudio.preload = "auto";
    vocalsAudio.volume = 0.3; // Initial 30% volume (user can adjust)
    vocalsAudioRef.current = vocalsAudio;

    return () => {
      vocalsAudio.pause();
      vocalsAudio.src = '';
      vocalsAudioRef.current = null;
    };
  }, [separatedAudio?.vocalsUrl]);

  // Sync vocals audio with main audio - only on play/pause state changes
  useEffect(() => {
    const vocalsAudio = vocalsAudioRef.current;
    const mainAudio = audioRef.current;
    if (!vocalsAudio || !separatedAudio?.vocalsUrl) return;

    if (isPlaying && vocalsEnabled) {
      // Sync time before playing
      if (mainAudio) {
        vocalsAudio.currentTime = mainAudio.currentTime;
      }
      vocalsAudio.play().catch(console.error);
    } else {
      vocalsAudio.pause();
    }
  }, [isPlaying, vocalsEnabled, separatedAudio?.vocalsUrl]);

  // Sync vocals audio time when user seeks (via click on progress bar)
  const lastSeekTimeRef = useRef<number>(0);
  const handleSeek = useCallback((newTime: number) => {
    lastSeekTimeRef.current = newTime;
    if (audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
    if (vocalsAudioRef.current) {
      vocalsAudioRef.current.currentTime = newTime;
    }
    setCurrentTime(newTime);
  }, []);

  // Update volume/mute when changed - instrumental always plays, vocals only when enabled
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume / 100;
      audioRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  // Vocals volume is independent and user-controllable
  useEffect(() => {
    if (vocalsAudioRef.current) {
      // Use user-defined vocalsVolume percentage
      const effectiveVocalsVolume = vocalsEnabled ? (volume / 100) * (vocalsVolume / 100) : 0;
      vocalsAudioRef.current.volume = isMuted ? 0 : effectiveVocalsVolume;
      vocalsAudioRef.current.muted = isMuted || !vocalsEnabled;
    }
  }, [volume, isMuted, vocalsEnabled, vocalsVolume]);

  // Accumulate score from live metrics while audio is playing.
  // Uses interval-based sampling for reliable updates at ~5Hz.
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

 useEffect(() => {
    if (!isPlaying || !isMicActive) return;
 
    const sampleScore = () => {
      const m = metricsRef.current;
 
      // Only sample when the reference vocals track is active (not instrumental section).
      // During instrumental sections we hold the score steady — don't reward or penalise.
      if (!m.referenceActive) return;
 
      // FIX: removed the `|| (hasActivity ? 60 : 0)` fallback that was masking
      // the silence penalty. When pitchMatch/rhythmMatch are 0 (user didn't sing),
      // that 0 should flow through — it means the user missed that section.
      // The only exception: if the hook hasn't warmed up yet (count < 3), skip.
      const count = scoreAccumulatorRef.current.count;
      if (count < 3 && !m.isVoiceDetected && m.pitchMatch === 0) {
        // Hook is still cold — skip this sample to avoid inflating the score
        // with zeros before the comparison has had time to stabilise.
        return;
      }
 
      const pitch     = m.pitchMatch;
      const rhythm    = m.rhythmMatch;
      const technique = m.techniqueMatch;
 
      scoreAccumulatorRef.current.pitch     += pitch;
      scoreAccumulatorRef.current.rhythm    += rhythm;
      scoreAccumulatorRef.current.technique += technique;
      scoreAccumulatorRef.current.count     += 1;
 
      console.log('[score] Sampled:', {
        pitch, rhythm, technique,
        voice: m.isVoiceDetected,
        refActive: m.referenceActive,
        volume: m.volume.toFixed(3),
        count: scoreAccumulatorRef.current.count,
      });
 
      if (scoreAccumulatorRef.current.count > 0) {
        const c = scoreAccumulatorRef.current;
        const avgPitch     = c.pitch     / c.count;
        const avgRhythm    = c.rhythm    / c.count;
        const avgTechnique = c.technique / c.count;
 
        const combined =
          avgPitch     * SCORE_WEIGHTS.pitch +
          avgRhythm    * SCORE_WEIGHTS.rhythm +
          avgTechnique * SCORE_WEIGHTS.technique;
 
        // Scale 0–100 → 0–1000 for the displayed score
        setTotalScore(Math.round(combined * 10));
      }
    };
 
    const intervalId = setInterval(sampleScore, 200);
    sampleScore();
    return () => clearInterval(intervalId);
  }, [isPlaying, isMicActive, SCORE_WEIGHTS]);

  
  const fetchLyrics = async (title: string, artist: string, album?: string, durationStr?: string) => {
    try {
      setLyrics([]);
      const data = await fetchLyricsCached({
        title,
        artist,
        album,
        duration: parseDurationToSeconds(durationStr),
      });
      if (data?.lyrics && data.lyrics.length > 0) {
        setLyrics(data.lyrics);
      } else {
        toast({
          title: "Lyrics not found",
          description: "Try editing the title to search again",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
      toast({
        title: "Lyrics not found",
        description: "Request timed out — try editing the title to search again",
        variant: "destructive"
      });
    }
  };

  const handleLyricsSearch = async () => {
    if (!lyricsSearchTitle.trim()) {
      toast({ title: "Please enter a song title", variant: "destructive" });
      return;
    }
    
    setIsSearchingLyrics(true);
    setLyricsSearchResults([]);
    setSelectedLyricsId("");
    
    try {
      const data = await fetchLyricsCached({
        title: lyricsSearchTitle.trim(),
        artist: lyricsSearchArtist.trim(),
        searchMultiple: true,
      });
      
      if (data?.results && data.results.length > 0) {
        setLyricsSearchResults(data.results);
        setSelectedLyricsId(String(data.results[0].id));
      } else {
        toast({ 
          title: "No lyrics found", 
          description: "Try a different search term",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Failed to search lyrics:', error);
      toast({ 
        title: "Failed to search lyrics", 
        description: "Please try again",
        variant: "destructive"
      });
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  const handleSelectLyrics = () => {
    const selected = lyricsSearchResults.find(r => String(r.id) === selectedLyricsId);
    if (selected) {
      setLyrics(selected.lyrics);
      setLyricsDialogOpen(false);
      setLyricsSearchResults([]);
      toast({ title: "Lyrics loaded", description: `${selected.trackName} by ${selected.artistName}` });
    }
  };

  const openLyricsDialog = () => {
    const cleanTitle = track?.title
      ?.replace(/\(.*?\)/g, '')
      ?.replace(/\[.*?\]/g, '')
      ?.replace(/karaoke|instrumental|lyrics|official|video|audio|hd|4k/gi, '')
      ?.replace(/&quot;|&amp;/g, '')
      ?.trim() || '';
    
    setLyricsSearchTitle(cleanTitle);
    setLyricsSearchArtist('');
    setLyricsSearchResults([]);
    setSelectedLyricsId("");
    setLyricsDialogOpen(true);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Update current line based on time
  useEffect(() => {
    if (lyrics.length === 0) return;
    
    const index = lyrics.findIndex((line, i) => {
      const nextLine = lyrics[i + 1];
      return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });
    setCurrentLineIndex(index);
  }, [currentTime, lyrics]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !isPlayerReady) return;

    if (isPlaying) {
      audio.pause();
      vocalsAudioRef.current?.pause();
      return;
    }

    // CRITICAL: Start audio playback FIRST in the user gesture for mobile compatibility
    try {
      await audio.play();
      // Start vocals if enabled
      if (vocalsEnabled && vocalsAudioRef.current) {
        vocalsAudioRef.current.currentTime = audio.currentTime;
        vocalsAudioRef.current.play().catch(console.error);
      }
    } catch (error) {
      console.error("Audio play() failed:", error);
      const name = (error as any)?.name;

      toast({
        title: name === "NotAllowedError" ? "Playback blocked" : "Playback failed",
        description:
          name === "NotSupportedError"
            ? "This track format isn't supported by your browser."
            : name === "NotAllowedError"
              ? "Tap Play again (browser requires a direct user action)."
              : "Unable to start playback. Try another song.",
        variant: "destructive",
      });
      return; // Don't start mic if audio failed
    }

    // Start mic AFTER audio playback has begun (non-blocking for the user)
    if (!isMicActive) {
      startAnalysis().catch((err) => {
        console.warn("Microphone permission denied/unavailable:", err);
      });
    }
  }, [isPlaying, isPlayerReady, isMicActive, startAnalysis, toast, vocalsEnabled]);

  const toggleMic = useCallback(async () => {
    if (isMicActive) {
      stopAnalysis();
    } else {
      await startAnalysis();
    }
  }, [isMicActive, startAnalysis, stopAnalysis]);

  const handleVolumeChange = useCallback((value: number[]) => {
    const newVolume = value[0];
    setVolume(newVolume);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted(!isMuted);
  }, [isMuted]);

  const toggleVocals = useCallback(() => {
    setVocalsEnabled(!vocalsEnabled);
  }, [vocalsEnabled]);

  const handleRestart = useCallback(() => {
    setCurrentTime(0);
    setTotalScore(0);
    scoreAccumulatorRef.current = { pitch: 0, rhythm: 0, technique: 0, count: 0 };
    resetScores();
    setShowResults(false);
    setShowScoreSubmission(false);
    preEndTriggeredRef.current = false;
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
    if (vocalsAudioRef.current) {
      vocalsAudioRef.current.currentTime = 0;
    }
  }, [resetScores]);

  // Trigger score submission dialog 3 seconds before song ends
  useEffect(() => {
    if (!isPlaying || duration === 0) return;
    
    const timeRemaining = duration - currentTime;
    
    if (timeRemaining <= 3 && timeRemaining > 0 && !preEndTriggeredRef.current && !showScoreSubmission && !showResults) {
      preEndTriggeredRef.current = true;
      setShowScoreSubmission(true);
    }
  }, [currentTime, duration, isPlaying, showScoreSubmission, showResults]);

  const handleScoreSubmit = async (displayName: string, city: string) => {
    if (!user || !track) {
      toast({ title: "Please sign in to save scores", variant: "destructive" });
      return;
    }

    setIsSaving(true);
    try {
      const avgPitch = scoreAccumulatorRef.current.count > 0 
        ? scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count : 0;
      const avgRhythm = scoreAccumulatorRef.current.count > 0 
        ? scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count : 0;

      const scoreRating = totalScore >= 900 ? 'L' : totalScore >= 800 ? 'S' : totalScore >= 700 ? 'A' : 
                   totalScore >= 600 ? 'B' : totalScore >= 500 ? 'C' : totalScore >= 300 ? 'D' : 'F';

      const { error } = await supabase.functions.invoke('submit-score', {
        body: {
          songTitle: track.title,
          songArtist: track.artist,
          trackId: track.id,
          score: totalScore,
          rating: scoreRating,
          timingAccuracy: Math.round(avgPitch),
          rhythmAccuracy: Math.round(avgRhythm),
          durationSeconds: Math.round(duration),
          playedSeconds: Math.round(currentTime),
          thumbnailUrl: track.thumbnail,
          displayName,
          city,
        },
      });

      if (error) throw error;

      toast({ title: "Score saved to leaderboard!" });
      setShowScoreSubmission(false);
      navigate('/leaderboard');
    } catch (error) {
      console.error('Failed to save score:', error);
      toast({ title: "Failed to save score", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCloseScoreSubmission = () => {
    setShowScoreSubmission(false);
    setShowResults(true);
  };

  const handleSaveScore = async () => {
    if (!user || !track) {
      toast({ title: "Please sign in to save scores", variant: "destructive" });
      return;
    }

    setIsSaving(true);
    try {
      const avgPitch = scoreAccumulatorRef.current.count > 0 
        ? scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count : 0;
      const avgRhythm = scoreAccumulatorRef.current.count > 0 
        ? scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count : 0;

      const rating = totalScore >= 900 ? 'L' : totalScore >= 800 ? 'S' : totalScore >= 700 ? 'A' : 
                     totalScore >= 600 ? 'B' : totalScore >= 500 ? 'C' : totalScore >= 300 ? 'D' : 'F';

      const { error } = await supabase.functions.invoke('submit-score', {
        body: {
          songTitle: track.title,
          songArtist: track.artist,
          trackId: track.id,
          score: totalScore,
          rating,
          timingAccuracy: Math.round(avgPitch),
          rhythmAccuracy: Math.round(avgRhythm),
          durationSeconds: Math.round(duration),
          playedSeconds: Math.round(currentTime),
          thumbnailUrl: track.thumbnail,
        },
      });

      if (error) throw error;

      toast({ title: "Score saved!" });
      navigate('/history');
    } catch (error) {
      console.error('Failed to save score:', error);
      toast({ title: "Failed to save score", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const getScoreColor = (value: number) => {
    if (value >= 80) return 'bg-score-perfect';
    if (value >= 60) return 'bg-score-great';
    if (value >= 40) return 'bg-score-good';
    return 'bg-score-miss';
  };

  const getRating = (score: number) => {
    if (score >= 900) return { letter: 'L', color: 'text-score-perfect' };
    if (score >= 800) return { letter: 'S', color: 'text-score-perfect' };
    if (score >= 700) return { letter: 'A', color: 'text-score-great' };
    if (score >= 600) return { letter: 'B', color: 'text-score-good' };
    if (score >= 500) return { letter: 'C', color: 'text-score-ok' };
    if (score >= 300) return { letter: 'D', color: 'text-score-ok' };
    return { letter: 'F', color: 'text-score-miss' };
  };

  const rating = getRating(totalScore);


  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">
      {showAudioDebug ? (
        <AudioDebugOverlay
          debug={{
            micActive: isMicActive,
            micError,
            volume: metrics.volume,
            voiceDetected: metrics.isVoiceDetected,
            referenceActive: metrics.referenceActive,
            voiceThreshold: metrics.debug?.voiceThreshold,
            noiseFloor: metrics.debug?.noiseFloor,
            audioCtxState: metrics.debug?.audioCtxState,
            micFallback: metrics.debug?.micFallback,
            userVolumeRmsFloat: metrics.debug?.userVolumeRmsFloat,
            userFreqEnergyDb: metrics.debug?.userFreqEnergyDb,
          }}
        />
      ) : null}
      {/* Header */}
      <header className="glass border-b border-border p-2 md:p-4 flex items-center gap-2 md:gap-4 shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">{track?.title || 'Loading...'}</h1>
          <p className="text-sm text-muted-foreground truncate">{track?.artist}</p>
        </div>
        
        {/* Edit Lyrics Search Button */}
        <Dialog open={lyricsDialogOpen} onOpenChange={setLyricsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" onClick={openLyricsDialog} className="shrink-0">
              <Edit2 className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">Edit Lyrics</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg bg-card max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Search Lyrics</DialogTitle>
              <DialogDescription>
                Search for synced lyrics from LRCLIB and select from the results.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4 flex-1 overflow-y-auto">
              <div className="space-y-2">
                <Label htmlFor="lyrics-title">Song Title</Label>
                <Input
                  id="lyrics-title"
                  placeholder="e.g., Tum Hi Ho"
                  value={lyricsSearchTitle}
                  onChange={(e) => setLyricsSearchTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLyricsSearch()}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lyrics-artist">Artist (optional)</Label>
                <Input
                  id="lyrics-artist"
                  placeholder="e.g., Arijit Singh"
                  value={lyricsSearchArtist}
                  onChange={(e) => setLyricsSearchArtist(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLyricsSearch()}
                />
              </div>
              
              {/* Search Results */}
              {lyricsSearchResults.length > 0 && (
                <div className="space-y-2 pt-2">
                  <Label>Select Lyrics ({lyricsSearchResults.length} results)</Label>
                  <RadioGroup value={selectedLyricsId} onValueChange={setSelectedLyricsId} className="space-y-2">
                    {lyricsSearchResults.map((result) => (
                      <label
                        key={result.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedLyricsId === String(result.id) 
                            ? 'border-primary bg-primary/10' 
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <RadioGroupItem value={String(result.id)} className="mt-1" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{result.trackName}</p>
                          <p className="text-sm text-muted-foreground truncate">{result.artistName}</p>
                          <div className="flex items-center gap-2 mt-1">
                            {result.albumName && (
                              <span className="text-xs text-muted-foreground truncate max-w-[150px]">
                                {result.albumName}
                              </span>
                            )}
                            {result.duration && (
                              <span className="text-xs text-muted-foreground">
                                {formatDuration(result.duration)}
                              </span>
                            )}
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              result.synced 
                                ? 'bg-score-perfect/20 text-score-perfect' 
                                : 'bg-muted text-muted-foreground'
                            }`}>
                              {result.synced ? 'Synced' : 'Plain'}
                            </span>
                          </div>
                        </div>
                        {selectedLyricsId === String(result.id) && (
                          <Check className="w-4 h-4 text-primary mt-1" />
                        )}
                      </label>
                    ))}
                  </RadioGroup>
                </div>
              )}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setLyricsDialogOpen(false)}>
                Cancel
              </Button>
              {lyricsSearchResults.length > 0 ? (
                <Button 
                  onClick={handleSelectLyrics}
                  disabled={!selectedLyricsId}
                  className="gradient-primary text-primary-foreground"
                >
                  <Check className="w-4 h-4 mr-2" />
                  Use Selected
                </Button>
              ) : (
                <Button 
                  onClick={handleLyricsSearch} 
                  disabled={isSearchingLyrics || !lyricsSearchTitle.trim()}
                  className="gradient-primary text-primary-foreground"
                >
                  {isSearchingLyrics ? (
                    <>Searching...</>
                  ) : (
                    <>
                      <Search className="w-4 h-4 mr-2" />
                      Search
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Vocals Volume Control - only show when separation is complete */}
        {separatedAudio && (
          <div className="flex items-center gap-2">
            <Button 
              variant={vocalsEnabled ? "default" : "outline"} 
              size="sm"
              onClick={toggleVocals}
              className={`shrink-0 gap-1.5 ${vocalsEnabled ? 'bg-primary hover:bg-primary/90' : ''}`}
              title={vocalsEnabled ? `Vocals at ${vocalsVolume}%` : 'Enable vocals'}
            >
              <VocalsIcon className="w-4 h-4" isActive={vocalsEnabled} />
              <span className="hidden sm:inline">
                {vocalsEnabled ? 'Vocals' : 'Vocals Off'}
              </span>
            </Button>
            {vocalsEnabled && (
              <Slider
                value={[vocalsVolume]}
                onValueChange={(v) => setVocalsVolume(v[0])}
                max={100}
                min={0}
                step={5}
                className="w-20 sm:w-24"
              />
            )}
          </div>
        )}
        
        {/* Volume Control */}
        <div className="hidden sm:flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={toggleMute}>
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </Button>
          <Slider
            value={[isMuted ? 0 : volume]}
            onValueChange={handleVolumeChange}
            max={100}
            step={1}
            className="w-24"
          />
        </div>
      </header>

      {/* Loading Dialog - shows while waiting for AI separation */}
      <AlertDialog open={isLoadingAudio && !!track}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <Loader2 className="w-12 h-12 animate-spin text-primary" />
                <Music className="w-5 h-5 text-primary absolute -top-1 -right-1 animate-pulse" />
              </div>
            </div>
            <AlertDialogTitle className="text-xl 2xl:text-2xl 3xl:text-3xl">
              Loading your song...
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base 2xl:text-lg 3xl:text-xl">
              {cacheProgress || (separatedAudio ? "Almost ready..." : "AI is separating vocals from the instrumental. This may take a few minutes...")}
            </AlertDialogDescription>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>

      {/* Score Submission Dialog - appears 3 seconds before song ends */}
      <ScoreSubmissionDialog
        isOpen={showScoreSubmission}
        onClose={handleCloseScoreSubmission}
        onSubmit={handleScoreSubmit}
        score={totalScore}
        rating={rating}
        songTitle={track?.title || 'Unknown Song'}
        isSubmitting={isSaving}
      />

      {/* Results Overlay */}
      {showResults && (
        <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
          <div className="text-center max-w-md">
            <p className={`text-8xl font-bold mb-4 animate-scale-in ${rating.color}`}>
              {rating.letter}
            </p>
            <p className="text-5xl font-bold text-gradient-gold mb-8">{totalScore}</p>
            
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Pitch <span className="text-primary/70">(40%)</span></p>
              </div>
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Rhythm <span className="text-primary/70">(30%)</span></p>
              </div>
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.technique / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Technique <span className="text-primary/70">(30%)</span></p>
              </div>
            </div>
            
            <div className="flex gap-4 justify-center">
              <Button variant="outline" size="lg" onClick={handleRestart}>
                <RotateCcw className="w-5 h-5 mr-2" />
                Try Again
              </Button>
              {user && (
                <Button 
                  size="lg" 
                  className="gradient-primary text-primary-foreground"
                  onClick={handleSaveScore}
                  disabled={isSaving}
                >
                  <Save className="w-5 h-5 mr-2" />
                  {isSaving ? 'Saving...' : 'Save Score'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lyrics Display */}
      <div className="flex-1 flex flex-col items-center justify-center p-2 md:p-8 overflow-hidden min-h-0">
        {!isPlayerReady ? (
          <div className="text-center py-4 md:py-12">
            <div className="w-12 h-12 md:w-16 md:h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-2 md:mb-4 animate-pulse">
              <Play className="w-6 h-6 md:w-8 md:h-8 text-muted-foreground" />
            </div>
            <p className="text-sm md:text-base text-muted-foreground">Loading audio...</p>
          </div>
        ) : (
          <div className="w-full max-w-4xl space-y-1 md:space-y-3 flex flex-col items-center">
            {lyrics.length === 0 ? (
              <div className="text-center py-12">
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg" />
                <p className="text-muted-foreground mt-4">Loading lyrics...</p>
              </div>
            ) : (
              lyrics.slice(Math.max(0, currentLineIndex - 1), currentLineIndex + 4).map((line, i) => {
                const actualIndex = Math.max(0, currentLineIndex - 1) + i;
                const isCurrent = actualIndex === currentLineIndex;
                const isPast = actualIndex < currentLineIndex;

                const nextLine = lyrics[actualIndex + 1];
                const effectiveDuration =
                  line.duration && line.duration > 0
                    ? line.duration
                    : nextLine
                      ? Math.max(0.25, nextLine.time - line.time)
                      : Math.max(0.25, duration - line.time);

                const lineProgress = isCurrent
                  ? Math.min(1, Math.max(0, (currentTime - line.time) / effectiveDuration))
                  : isPast
                    ? 1
                    : 0;

                // Split text into grapheme clusters (properly handles multi-byte chars like Hindi/Marathi)
                const chars = [...line.text];
                const highlightedCharCount = isCurrent 
                  ? Math.floor(lineProgress * chars.length) 
                  : isPast 
                    ? chars.length 
                    : 0;

                return (
                  <div
                    key={actualIndex}
                    className={`text-center transition-all duration-300 w-full ${
                      isCurrent
                        ? 'text-xl md:text-3xl lg:text-4xl 2xl:text-5xl 3xl:text-6xl 4xl:text-7xl 5xl:text-8xl font-bold scale-100 opacity-100'
                        : isPast
                          ? 'text-base md:text-lg lg:text-xl 2xl:text-2xl 3xl:text-3xl 4xl:text-4xl 5xl:text-5xl opacity-40 scale-95'
                          : 'text-base md:text-lg lg:text-xl 2xl:text-2xl 3xl:text-3xl 4xl:text-4xl 5xl:text-5xl opacity-60 scale-95'
                    }`}
                  >
                    <span>
                      {chars.map((char, charIdx) => (
                        <span
                          key={charIdx}
                          className={
                            charIdx < highlightedCharCount
                              ? isPast
                                ? 'text-primary/70'
                                : 'text-primary'
                              : 'text-muted-foreground'
                          }
                        >
                          {char}
                        </span>
                      ))}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Score Display */}
      <div className="glass border-t border-border p-2 md:p-4 3xl:p-6 4xl:p-8 shrink-0">
        <div className="flex items-center justify-between max-w-4xl 3xl:max-w-6xl 4xl:max-w-7xl mx-auto">
          <div className="flex items-center gap-2 md:gap-4 3xl:gap-6">
            <div className="text-center">
              <p className="text-xl md:text-3xl 3xl:text-4xl 4xl:text-5xl font-bold text-gradient-gold">{totalScore}</p>
              <p className="text-[10px] md:text-xs 3xl:text-sm 4xl:text-base text-muted-foreground">Score</p>
            </div>
            <div className={`text-lg md:text-2xl 3xl:text-3xl 4xl:text-4xl font-bold ${rating.color}`}>
              {rating.letter}
            </div>
          </div>

          {/* Live Metrics */}
          {isMicActive && (
            <div className="hidden md:flex items-center gap-3 3xl:gap-5 4xl:gap-6">
              <div className="text-center">
                <div className={`h-1 3xl:h-2 4xl:h-3 w-12 3xl:w-16 4xl:w-20 rounded-full ${getScoreColor(metrics.pitchMatch)}`} />
                <p className="text-xs 3xl:text-sm 4xl:text-base text-muted-foreground mt-1">Pitch</p>
              </div>
              <div className="text-center">
                <div className={`h-1 3xl:h-2 4xl:h-3 w-12 3xl:w-16 4xl:w-20 rounded-full ${getScoreColor(metrics.rhythmMatch)}`} />
                <p className="text-xs 3xl:text-sm 4xl:text-base text-muted-foreground mt-1">Rhythm</p>
              </div>
              <div className="text-center">
                <div className={`h-1 3xl:h-2 4xl:h-3 w-12 3xl:w-16 4xl:w-20 rounded-full ${getScoreColor(metrics.techniqueMatch)}`} />
                <p className="text-xs 3xl:text-sm 4xl:text-base text-muted-foreground mt-1">Technique</p>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-1 md:gap-2 3xl:gap-4">
            <Button
              variant="outline"
              size="icon"
              onClick={toggleMic}
              className={`w-9 h-9 md:w-10 md:h-10 3xl:w-14 3xl:h-14 4xl:w-16 4xl:h-16 ${isMicActive ? 'bg-primary text-primary-foreground' : ''}`}
            >
              {isMicActive ? <Mic className="w-4 h-4 md:w-5 md:h-5 3xl:w-7 3xl:h-7 4xl:w-8 4xl:h-8" /> : <MicOff className="w-4 h-4 md:w-5 md:h-5 3xl:w-7 3xl:h-7 4xl:w-8 4xl:h-8" />}
            </Button>
            
            <Button
              size="lg"
              onClick={togglePlay}
              disabled={!isPlayerReady || isLoadingFromCache || !separatedAudio}
              className="gradient-primary text-primary-foreground w-12 h-12 md:w-16 md:h-16 3xl:w-20 3xl:h-20 4xl:w-24 4xl:h-24 rounded-full disabled:opacity-50"
              title={!separatedAudio ? 'Waiting for AI separation...' : isPlaying ? 'Pause' : 'Play'}
            >
              {isLoadingFromCache ? <Loader2 className="w-6 h-6 md:w-8 md:h-8 3xl:w-10 3xl:h-10 4xl:w-12 4xl:h-12 animate-spin" /> : isPlaying ? <Pause className="w-6 h-6 md:w-8 md:h-8 3xl:w-10 3xl:h-10 4xl:w-12 4xl:h-12" /> : <Play className="w-6 h-6 md:w-8 md:h-8 3xl:w-10 3xl:h-10 4xl:w-12 4xl:h-12 ml-0.5" />}
            </Button>

            <Button variant="outline" size="icon" onClick={handleRestart} className="w-9 h-9 md:w-10 md:h-10 3xl:w-14 3xl:h-14 4xl:w-16 4xl:h-16">
              <RotateCcw className="w-4 h-4 md:w-5 md:h-5 3xl:w-7 3xl:h-7 4xl:w-8 4xl:h-8" />
            </Button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="max-w-4xl 3xl:max-w-6xl 4xl:max-w-7xl mx-auto mt-2 md:mt-4 3xl:mt-6">
          <div
            className="h-1 3xl:h-2 4xl:h-3 bg-muted rounded-full cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              const newTime = percent * duration;
              handleSeek(newTime);
            }}
          >
            <div
              className="h-full bg-primary rounded-full transition-none"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] md:text-xs 3xl:text-sm 4xl:text-base text-muted-foreground mt-0.5 md:mt-1">
            <span>{formatDuration(currentTime)}</span>
            <span>{formatDuration(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Sing;
