import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {

} from "@/components/ui/dialog";
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
import { ArrowLeft, Play, Pause, Mic, MicOff, RotateCcw, Save, Volume2, VolumeX, Search, Check, Loader2 } from "lucide-react";
import { SeparationWaitScreen } from "@/components/SeparationWaitScreen";
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
import { useBackGuard, useBeforeUnloadGuard } from "@/hooks/useBackGuard";
import { saveCachedTracks } from "@/lib/audioCache";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn';
  audioUrl: string;
  album?: string;
  language?: string; // "hindi", "punjabi", "english", etc. from Saavn
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
  const trackDurationSecs = track?.duration ? parseDurationToSeconds(track.duration) ?? 0 : 0;
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [totalScore, setTotalScore] = useState(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  // Use a ref for separationStartedAt so it never resets when the audio
  // player effect re-runs after separatedAudio becomes available.
  // A state would reset the progress bar back to 0% on re-run.
  const separationStartedAtRef = useRef<number | null>(null);
  const [separationStartedAt, setSeparationStartedAt] = useState<number | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const [showScoreSubmission, setShowScoreSubmission] = useState(false);
  const preEndTriggeredRef = useRef(false);

  // ── Exit-confirm overlay (back button pressed mid-performance) ─────────
  // Shows the same score/rating breakdown as the end-of-song results,
  // with Leave / Keep Singing choices instead of Try Again / Save Score.
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const pendingConfirmLeaveRef = useRef<(() => void) | null>(null);
  const wasPlayingBeforeExitPromptRef = useRef(false);

  // ── Pause checkpoint overlay ─────────────────────────────────────────────
  // Shows the same score/rating breakdown with an encouraging message when
  // the user pauses after 30+ seconds of singing since the last checkpoint
  // (or song start). Quick pause/resume taps (e.g. adjusting volume) don't
  // trigger it.
  const [showPauseCheckpoint, setShowPauseCheckpoint] = useState(false);
  const lastCheckpointAtSecondsRef = useRef(0);

  // ── IndexedDB caching (background, post-buffer-complete only) ──────────
  // Fires once per track, only after the song has FULLY buffered -- never
  // interferes with streaming playback or the initial reference-audio load.
  const cachingTriggeredRef = useRef(false);
  
  // Lyrics search dialog state
  // Lyrics: fetched silently in background. No dialog/popup.
  const [lyricsNotFound, setLyricsNotFound] = useState(false);
  
  // Main instrumental audio
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Audible guide vocals element. The hook's internal audio is muted (analysis
  // only). This element is what the user actually hears through the speakers.
  const vocalsAudioRef = useRef<HTMLAudioElement | null>(null);
  // NOTE: vocals audio element is now owned by useVocalsComparison hook (not Sing.tsx).
  // This fixes the Web Audio routing that previously made vocals inaudible.
  const timeSyncRafRef = useRef<number | null>(null);
  const scoreAccumulatorRef = useRef({ pitch: 0, rhythm: 0, technique: 0, count: 0 });

  // New scoring weights: Pitch 40%, Rhythm 30%, Technique 30% (no diction)
  const SCORE_WEIGHTS = useRef({ pitch: 0.4, rhythm: 0.3, technique: 0.3 }).current;

  // ── Android hardware volume fix ─────────────────────────────────────────
  // On Android, hardware volume buttons control call/ringtone volume until
  // media playback starts. Creating a silent AudioContext on mount tells
  // Android to route volume buttons to media volume immediately.
  // Also works on iOS via the webkit prefix.
  useEffect(() => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const silentCtx = new Ctx();
      // Create a silent oscillator to "start" media playback
      const osc = silentCtx.createOscillator();
      const gain = silentCtx.createGain();
      gain.gain.value = 0; // completely silent
      osc.connect(gain);
      gain.connect(silentCtx.destination);
      osc.start();
      osc.stop(silentCtx.currentTime + 0.001); // stop after 1ms
      // Set audio session type for volume routing
      if ('audioSession' in navigator && (navigator as any).audioSession) {
        try { (navigator as any).audioSession.type = 'playback'; } catch {}
      }
      console.log('[audio] Silent media context created for volume button routing');
      // Clean up after a short delay
      setTimeout(() => {
        try { silentCtx.close(); } catch {}
      }, 1000);
    } catch (e) {
      console.warn('[audio] Silent context failed:', e);
    }
  }, []);

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
    setRefVolume,
  } = useVocalsComparison({
    vocalsUrl: separatedAudio?.vocalsUrl,
    currentTime,
    isPlaying,
  });

  const showAudioDebug = new URLSearchParams(window.location.search).get('debugAudio') === '1';

  // Vocals volume control (0-100, default 30%)
  const [vocalsVolume, setVocalsVolume] = useState(40);
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
            fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration, parsed.language);
          }
        } catch {
          fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration, parsed.language);
        }
        // Clean up after use
        sessionStorage.removeItem('prefetchedLyrics');
      } else {
        fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration, parsed.language);
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

  // Reset per-track guards (caching, checkpoint timer) once per genuinely new
  // track -- keyed on audioUrl so it does not fire again on unrelated re-runs.
  const perTrackResetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!track?.audioUrl) return;
    if (perTrackResetRef.current === track.audioUrl) return;
    perTrackResetRef.current = track.audioUrl;
    cachingTriggeredRef.current = false;
    lastCheckpointAtSecondsRef.current = 0;
  }, [track?.audioUrl]);

  // Initialize HTML5 Audio Player - Demucs instrumental or fallback to original
  useEffect(() => {
    if (!track?.audioUrl) return;

    let isMounted = true;
    // Only show the wait screen if separation is still in progress.
    // If separatedAudio is already available (effect re-ran due to dep change),
    // skip setIsLoadingAudio(true) -- the wait screen should not reappear.
    if (!separatedAudio) {
      setIsLoadingAudio(true);
    }
    // Only record start time once -- do not reset if effect re-runs after
    // separatedAudio becomes available (which would restart the progress bar).
    if (!separationStartedAtRef.current) {
      separationStartedAtRef.current = Date.now();
      setSeparationStartedAt(separationStartedAtRef.current);
    }
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
        const saavnDur = trackDurationSecs;
        setDuration(saavnDur > 0 ? Math.min(audio.duration, saavnDur) : audio.duration);
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
        // Log buffering progress at most once every 10 seconds to reduce log volume
        const bufferedEnd = Math.round(audio.buffered.end(0));
        if (bufferedEnd % 10 === 0) {
          console.log('[sing] progress: buffered', bufferedEnd, 's');
        }

        // Once the song has FULLY buffered (not just enough to play), cache
        // the separated stems in IndexedDB in the background for instant
        // replay next time. Fires once per track. Streaming playback is
        // completely untouched -- this only runs after buffering is
        // already complete, well clear of the reference-audio load window.
        if (
          !cachingTriggeredRef.current &&
          audio.duration > 0 &&
          audio.buffered.end(audio.buffered.length - 1) >= audio.duration - 1 &&
          separatedAudio &&
          !separatedAudio.fromCache &&
          track?.audioUrl
        ) {
          cachingTriggeredRef.current = true;
          const instUrl = separatedAudio.instrumentalUrl;
          const vocUrl = separatedAudio.vocalsUrl;
          const originalAudioUrl = track.audioUrl;
          (async () => {
            try {
              console.log('[Cache] Song fully buffered -- caching stems in background');
              const instResp = await fetch(instUrl);
              const instBlob = await instResp.blob();
              let vocBlob: Blob | undefined;
              if (vocUrl) {
                const vocResp = await fetch(vocUrl);
                vocBlob = await vocResp.blob();
              }
              await saveCachedTracks(originalAudioUrl, instBlob, vocBlob);
              console.log('[Cache] Saved to IndexedDB -- instant replay next time');
            } catch (e) {
              console.warn('[Cache] Background caching failed (non-fatal):', e);
            }
          })();
        }
      }
    });
    audio.addEventListener('stalled', () => console.log('[sing] stalled'));
    audio.addEventListener('waiting', () => console.log('[sing] waiting'));
    audio.addEventListener('suspend', () => console.log('[sing] suspend'));

    const onTimeUpdate = () => {
      if (!isMounted) return;
      setCurrentTime(audio.currentTime);
      // End song at Saavn duration to avoid trailing silence from MDX padding.
      // Also catches cases where onEnded does not fire.
      const effectiveDur = trackDurationSecs > 0
        ? Math.min(audio.duration || Infinity, trackDurationSecs)
        : audio.duration;
      if (effectiveDur && effectiveDur > 0 && audio.currentTime >= effectiveDur - 0.5 && !audio.paused) {
        audio.pause();
        setIsPlaying(false);
        stopTimeSync();
        setShowResults(true);
      }
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
        setShowResults(true);
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
      // separatedAudio not yet ready — separation still in progress.
      // Keep isLoadingAudio=true so the wait screen stays visible.
      // This effect will re-run when separatedAudio becomes available.
      // (isLoadingAudio will be set false by markReady() once audio loads.)
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

  // ── Audible guide vocals (separate from hook's muted analysis element) ────
  // The hook's audio is muted so the mic doesn't pick up speaker output.
  // This element handles audible playback only — no Web Audio graph needed.
  useEffect(() => {
    if (!separatedAudio?.vocalsUrl) {
      if (vocalsAudioRef.current) {
        vocalsAudioRef.current.pause();
        vocalsAudioRef.current.src = '';
        vocalsAudioRef.current = null;
      }
      return;
    }
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = separatedAudio.vocalsUrl;
    audio.preload = 'auto';
    // Set volume immediately — the volume sync effect won't fire
    // because vocalsVolume hasn't changed since mount.
    audio.volume = (vocalsEnabled && !isMuted && vocalsVolume > 0) ? vocalsVolume / 100 : 0;
    audio.muted = isMuted || !vocalsEnabled || vocalsVolume === 0;
    vocalsAudioRef.current = audio;
    return () => {
      audio.pause();
      audio.src = '';
      vocalsAudioRef.current = null;
    };
  }, [separatedAudio?.vocalsUrl]);

  // Play/pause audible vocals in sync with main player
  useEffect(() => {
    const audio = vocalsAudioRef.current;
    if (!audio || !separatedAudio?.vocalsUrl) return;
    if (isPlaying && vocalsEnabled) {
      if (audioRef.current) audio.currentTime = audioRef.current.currentTime;
      audio.play().catch(console.error);
    } else {
      audio.pause();
    }
  }, [isPlaying, vocalsEnabled, separatedAudio?.vocalsUrl]);

  // Sync vocals audio time when user seeks (via click on progress bar)
  const lastSeekTimeRef = useRef<number>(0);
  const handleSeek = useCallback((newTime: number) => {
    lastSeekTimeRef.current = newTime;
    if (audioRef.current) audioRef.current.currentTime = newTime;
    if (vocalsAudioRef.current) vocalsAudioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, []);

  // Update volume/mute when changed - instrumental always plays, vocals only when enabled
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume / 100;
      audioRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  // Sync vocals volume to the audible guide vocals element.
  // Vocals volume is intentionally INDEPENDENT of the main volume slider.
  // The main slider controls the instrumental track only.
  // When the vocals slider is at 100% the user expects full volume (1.0),
  // not 80% of full because the main slider happens to be at 80%.
  useEffect(() => {
    if (!vocalsAudioRef.current) return;
    const effectiveVolume = (vocalsEnabled && !isMuted && vocalsVolume > 0)
      ? vocalsVolume / 100
      : 0;
    vocalsAudioRef.current.volume = effectiveVolume;
    // Mute when: globally muted, vocals disabled, OR slider at 0
    vocalsAudioRef.current.muted = isMuted || !vocalsEnabled || vocalsVolume === 0;
  }, [isMuted, vocalsEnabled, vocalsVolume]);

  // ── Live score display ────────────────────────────────────────────────────
  // The hook already computes EMA-based pitchMatch/rhythmMatch/techniqueMatch.
  // All we need to do here is combine them with weights and scale to 0–1000.
  //
  // We use the hook's onMetricsUpdate callback (fires every RAF frame) instead
  // of an interval, so the display is always in sync with the analysis loop.
  // The scoreAccumulatorRef is kept for the end-of-song breakdown display only.
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  useEffect(() => {
    if (!isPlaying || !isMicActive) return;

    const handleMetrics = (m: typeof metrics) => {
      // During instrumental sections, hold score steady
      if (!m.referenceActive) return;

      const pitch     = m.pitchMatch;
      const rhythm    = m.rhythmMatch;
      const technique = m.techniqueMatch;

      // Keep the accumulator updated for the end-of-song breakdown display
      scoreAccumulatorRef.current.pitch     += pitch;
      scoreAccumulatorRef.current.rhythm    += rhythm;
      scoreAccumulatorRef.current.technique += technique;
      scoreAccumulatorRef.current.count     += 1;

      // BUG FIXED HERE: the headline score must be computed from the
      // RUNNING AVERAGE (same source as the breakdown percentages below),
      // not from this single instantaneous sample. The old code called
      // setTotalScore() every 200ms using only the latest tick's pitch/
      // rhythm/technique values -- so the "final" score shown at pause/
      // song-end was whatever the score happened to be in that one instant,
      // not an average across the performance. A rough final note or a
      // brief dip right before pausing could tank the headline number even
      // though the breakdown (a true session average) still looked strong
      // -- e.g. Pitch 31% / Rhythm 17% / Technique 61% should combine to
      // 358, but the instantaneous-snapshot bug was showing 304.
      const { pitch: sumPitch, rhythm: sumRhythm, technique: sumTechnique, count } =
        scoreAccumulatorRef.current;
      const avgPitch = sumPitch / count;
      const avgRhythm = sumRhythm / count;
      const avgTechnique = sumTechnique / count;

      const combined =
        avgPitch     * SCORE_WEIGHTS.pitch +
        avgRhythm    * SCORE_WEIGHTS.rhythm +
        avgTechnique * SCORE_WEIGHTS.technique;

      // Scale 0-100 -> 0-1000 for the displayed score. Now derived from the
      // same running averages as the breakdown, so the two always agree.
      setTotalScore(Math.round(combined * 10));
    };

    // Poll metricsRef at 5 Hz as a fallback display update
    // (onMetricsUpdate from the hook is the primary path)
    const intervalId = setInterval(() => handleMetrics(metricsRef.current), 200);
    return () => clearInterval(intervalId);
  }, [isPlaying, isMicActive, SCORE_WEIGHTS]);

  
  const fetchLyrics = async (title: string, artist: string, album?: string, durationStr?: string, language?: string) => {
    const dur = parseDurationToSeconds(durationStr);
    setLyrics([]);

    // Attempt 1: full params (title + artist + album + duration)
    try {
      const data = await fetchLyricsCached({ title, artist, album, duration: dur, language });
      if (data?.lyrics && data.lyrics.length > 0) {
        setLyrics(data.lyrics);
        setLyricsNotFound(false);
        return;
      }
    } catch (e) {
      console.warn('[Lyrics] Attempt 1 failed:', (e as Error).message);
    }

    // Attempt 2: title + artist only (no album)
    try {
      const data = await fetchLyricsCached({ title, artist, duration: dur, language });
      if (data?.lyrics && data.lyrics.length > 0) {
        setLyrics(data.lyrics);
        setLyricsNotFound(false);
        return;
      }
    } catch (e) {
      console.warn('[Lyrics] Attempt 2 failed:', (e as Error).message);
    }

    // Attempt 3: title only (broadest search)
    try {
      const data = await fetchLyricsCached({ title, duration: dur, language });
      if (data?.lyrics && data.lyrics.length > 0) {
        setLyrics(data.lyrics);
        setLyricsNotFound(false);
        return;
      }
    } catch (e) {
      console.warn('[Lyrics] Attempt 3 failed:', (e as Error).message);
    }

    console.log('[Lyrics] Not found after 3 attempts for:', title, artist);
    setLyricsNotFound(true);
  };

  const handleRetryLyrics = () => {
    if (track) {
      setLyricsNotFound(false);
      // Full cascade retry
      fetchLyrics(track.title, track.artist, track.album, track.duration, track.language);
    }
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
      // Hook's vocals audio is paused via isPlaying prop update

      // Pause checkpoint: only show the score/encouragement overlay if the
      // user has actually sung for 30+ seconds since the last checkpoint
      // (or song start). Quick pause/resume taps (adjusting volume, fixing
      // the mic) stay silent -- this must not get in the way of normal use.
      const elapsedSinceCheckpoint = audio.currentTime - lastCheckpointAtSecondsRef.current;
      if (elapsedSinceCheckpoint >= 30) {
        lastCheckpointAtSecondsRef.current = audio.currentTime;
        setShowPauseCheckpoint(true);
      }
      return;
    }

    // Resuming from a checkpoint or exit-confirm -- make sure both overlays
    // are dismissed so they don't linger over the resumed performance.
    setShowPauseCheckpoint(false);
    setShowExitConfirm(false);

    // CRITICAL: Start audio playback FIRST in the user gesture for mobile compatibility
    try {
      await audio.play();
      // Hook's vocals audio is started via isPlaying prop update
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
    setShowExitConfirm(false);
    setShowPauseCheckpoint(false);
    lastCheckpointAtSecondsRef.current = 0;
    preEndTriggeredRef.current = false;
    separationStartedAtRef.current = null;
    setSeparationStartedAt(null);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
    if (vocalsAudioRef.current) {
      vocalsAudioRef.current.currentTime = 0;
    }
    // Hook's vocals audio is synced via currentTime prop
  }, [resetScores]);

  // Score submission dialog is shown AFTER the song ends naturally (via onEnded).
  // We no longer interrupt the last few seconds of the song.
  // preEndTriggeredRef is kept for safety but no longer set mid-song.
  // (Previously this triggered at timeRemaining <= 3, cutting off the ending.)

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

  // ── Back button guard (hardware/gesture back + in-app arrow) ───────────
  // Mid-performance is defined as: currently playing, OR paused partway
  // through a song that has accumulated some score (not at the very start,
  // not already showing results). Landing on the page or finishing the
  // song normally does not need a confirmation -- there's nothing to lose.
  const isMidPerformance = () => {
    if (showResults) return false; // already finished, nothing to protect
    if (isPlaying) return true;
    return currentTime > 0 && scoreAccumulatorRef.current.count > 0;
  };

  const handleBackAttempt = useCallback((confirmLeave: () => void) => {
    if (isMidPerformance()) {
      // Pause playback while the confirm dialog is up -- letting it keep
      // singing behind a "do you want to leave" prompt would be confusing.
      wasPlayingBeforeExitPromptRef.current = isPlaying;
      if (isPlaying && audioRef.current) {
        audioRef.current.pause();
      }
      pendingConfirmLeaveRef.current = confirmLeave;
      setShowExitConfirm(true);
    } else {
      confirmLeave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, showResults, currentTime]);

  useBackGuard(handleBackAttempt);
  useBeforeUnloadGuard(isMidPerformance);

  const handleKeepSinging = useCallback(() => {
    setShowExitConfirm(false);
    if (wasPlayingBeforeExitPromptRef.current && audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
  }, []);


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
        <Button variant="ghost" size="icon" onClick={() => handleBackAttempt(() => navigate('/'))}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">{track?.title || 'Loading...'}</h1>
          <p className="text-sm text-muted-foreground truncate">{track?.artist}</p>
        </div>
        
        {/* Edit Lyrics Search Button */}


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

      {/* Separation Wait Screen */}
      <SeparationWaitScreen
        track={track}
        isVisible={!separatedAudio && !!track}
        startedAt={separationStartedAt}
        estimatedSeconds={35}
      />

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

      {/* Shared score breakdown -- used by end-of-song results, exit-confirm,
          and pause-checkpoint overlays so the three stay visually consistent. */}
      {(() => {
        const scoreBreakdown = (
          <>
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
          </>
        );

        const checkpointMessage =
          rating.letter === 'L' || rating.letter === 'S' || rating.letter === 'A'
            ? "You're on fire! \ud83d\udd25"
            : rating.letter === 'B' || rating.letter === 'C'
              ? "You're doing great! Let's continue"
              : "Keep going, you've got this!";

        return (
          <>
            {/* End-of-song results */}
            {showResults && (
              <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
                <div className="text-center max-w-md">
                  {scoreBreakdown}
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

            {/* Exit-confirm: back button pressed mid-performance */}
            {showExitConfirm && (
              <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
                <div className="text-center max-w-md">
                  <p className="text-lg text-muted-foreground mb-4">Here's how you're doing so far</p>
                  {scoreBreakdown}
                  <div className="flex gap-4 justify-center">
                    <Button variant="outline" size="lg" onClick={handleKeepSinging}>
                      Keep Singing
                    </Button>
                    <Button
                      size="lg"
                      variant="destructive"
                      onClick={() => pendingConfirmLeaveRef.current?.()}
                    >
                      Leave
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Pause checkpoint: 30+ seconds sung since last checkpoint */}
            {showPauseCheckpoint && (
              <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
                <div className="text-center max-w-md">
                  <p className="text-lg font-semibold mb-4">{checkpointMessage}</p>
                  {scoreBreakdown}
                  <div className="flex gap-4 justify-center">
                    <Button
                      size="lg"
                      className="gradient-primary text-primary-foreground"
                      onClick={togglePlay}
                    >
                      <Play className="w-5 h-5 mr-2" />
                      Continue
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Lyrics Display */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 md:p-8 overflow-hidden min-h-0">
        <div className="w-full max-w-4xl space-y-4 md:space-y-6 flex flex-col items-center">
            {!isPlayerReady && lyrics.length === 0 && !lyricsNotFound ? (
              <div className="text-center py-4 md:py-12">
                <div className="w-12 h-12 md:w-16 md:h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-2 md:mb-4 animate-pulse">
                  <Play className="w-6 h-6 md:w-8 md:h-8 text-muted-foreground" />
                </div>
                <p className="text-sm md:text-base text-muted-foreground">Loading audio...</p>
              </div>
            ) : lyricsNotFound ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground mb-3">Lyrics not found</p>
                <button
                  onClick={handleRetryLyrics}
                  className="text-sm text-primary underline underline-offset-4 hover:opacity-80"
                >
                  Try again
                </button>
              </div>
            ) : lyrics.length === 0 ? (
              <div className="text-center py-12">
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg" />
                <p className="text-muted-foreground mt-4">Loading lyrics...</p>
              </div>
            ) : (
              lyrics.slice(Math.max(0, currentLineIndex - 1), currentLineIndex + 2).map((line, i) => {
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
                        ? 'text-4xl md:text-5xl lg:text-6xl 2xl:text-7xl font-bold scale-100 opacity-100 leading-tight'
                        : isPast
                          ? 'text-2xl md:text-3xl lg:text-4xl 2xl:text-5xl opacity-40 scale-95 leading-tight'
                          : 'text-2xl md:text-3xl lg:text-4xl 2xl:text-5xl opacity-60 scale-95 leading-tight'
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
      </div>

      {/* Score Display */}
      <div className="glass border-t border-border px-4 pt-3 pb-2 md:px-6 md:pt-4 md:pb-3 shrink-0">
        {/* Score row: number left, metrics center, rating right */}
        <div className="flex items-end justify-between mb-3 max-w-4xl mx-auto">
          <div className="flex items-baseline gap-2">
            <p className="text-5xl md:text-6xl font-bold text-gradient-gold leading-none">{totalScore}</p>
            <p className="text-sm text-muted-foreground mb-1">Score</p>
          </div>

          {/* Live Metrics */}
          {isMicActive && (
            <div className="flex items-end gap-3">
              <div className="text-center">
                <div className={`h-1 w-10 rounded-full ${getScoreColor(metrics.pitchMatch)}`} />
                <p className="text-[10px] text-muted-foreground mt-1">Pitch</p>
              </div>
              <div className="text-center">
                <div className={`h-1 w-10 rounded-full ${getScoreColor(metrics.rhythmMatch)}`} />
                <p className="text-[10px] text-muted-foreground mt-1">Rhythm</p>
              </div>
              <div className="text-center">
                <div className={`h-1 w-10 rounded-full ${getScoreColor(metrics.techniqueMatch)}`} />
                <p className="text-[10px] text-muted-foreground mt-1">Tech</p>
              </div>
            </div>
          )}

          <div className={`text-5xl md:text-6xl font-bold leading-none ${rating.color}`}>
            {rating.letter}
          </div>
        </div>

        {/* Controls: Mic — Play — Redo, full width */}
        <div className="flex items-center justify-between max-w-4xl mx-auto mb-3">
          <Button
            variant="outline"
            size="icon"
            onClick={toggleMic}
            className={`w-12 h-12 md:w-14 md:h-14 rounded-full ${isMicActive ? 'bg-primary text-primary-foreground border-primary' : ''}`}
          >
            {isMicActive ? <Mic className="w-5 h-5 md:w-6 md:h-6" /> : <MicOff className="w-5 h-5 md:w-6 md:h-6" />}
          </Button>

          <Button
            size="lg"
            onClick={togglePlay}
            disabled={!isPlayerReady || isLoadingFromCache || !separatedAudio}
            className="gradient-primary text-primary-foreground w-16 h-16 md:w-20 md:h-20 rounded-full disabled:opacity-50 shadow-lg"
            title={!separatedAudio ? 'Waiting for AI separation...' : isPlaying ? 'Pause' : 'Play'}
          >
            {isLoadingFromCache ? <Loader2 className="w-7 h-7 md:w-9 md:h-9 animate-spin" /> : isPlaying ? <Pause className="w-7 h-7 md:w-9 md:h-9" /> : <Play className="w-7 h-7 md:w-9 md:h-9 ml-0.5" />}
          </Button>

          <Button variant="outline" size="icon" onClick={handleRestart} className="w-12 h-12 md:w-14 md:h-14 rounded-full">
            <RotateCcw className="w-5 h-5 md:w-6 md:h-6" />
          </Button>
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
