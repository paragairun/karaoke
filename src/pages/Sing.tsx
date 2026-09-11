// =============================================================================
// Sing.tsx — Karaoke player page
// =============================================================================
// CHANGELOG
// v-lovable — Original. Many bugs, dead state, broken types.
// v2..v12 — Incremental patches: separation pipeline, scoring, caching,
//            party context, vocals guide, back guard, wake lock, etc.
// v13 — CURRENT: Full clean rewrite.
//   REMOVED (dead code):
//   - isSaving state (unused — scoreSaveStatus covers it)
//   - Input import (not used in render)
//   - Volume2/VolumeX imports (volume slider hidden on mobile, removed)
//   - AlertDialog imports (not used — exit confirm is inline overlay)
//   - Home import (unused)
//   - onKeyPress (deprecated) — not used
//   - getScoreColor (colour bars replaced by percentage text in new UI)
//   - handleVolumeChange / toggleMute (volume control removed from mobile UI)
//   - volume / isMuted state (removed with volume control)
//   FIXED:
//   - Track.source widened to 'saavn' | 'youtube' (Gaana returns 'saavn',
//     YouTube returns 'youtube' — was typed as literal 'saavn' only)
//   - scoreAccumulatorRef field names renamed pitch/rhythm/technique →
//     accuracy/flow/expression to match the new scoring pillars
//   - generateScoreCardImage updated to use new field names
//   - submitScoreToLeaderboard updated to use new field names
//   UI:
//   - New bottom panel: score hero centre, metrics left, rating right
//   - Vocals slider always in bottom panel (not in header)
//   - Header simplified: back, title, vocals toggle pill
//   - Score breakdown overlay updated: Accuracy/Flow/Expression labels
//   - Results screen: 4-button row (Home / Share / Leaderboard / Again)
// =============================================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ArrowLeft, Play, Pause, Mic, MicOff, RotateCcw, Search, Check, Loader2, Share2, X, Home, Trophy } from "lucide-react";
import { SeparationWaitScreen } from "@/components/SeparationWaitScreen";
import { VocalsIcon } from "@/components/icons/VocalsIcon";
import { AudioDebugOverlay } from "@/components/karaoke/AudioDebugOverlay";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalsComparison } from "@/hooks/useVocalsComparison";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { useVocalSeparation } from "@/hooks/useVocalSeparation";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";
import { analyzeVocalActivity, getLineSingingDuration, type VocalInterval } from "@/lib/vocalActivityAnalyzer";
import { useBackGuard, useBeforeUnloadGuard } from "@/hooks/useBackGuard";
import { useWakeLock } from "@/hooks/useWakeLock";
import { setAudioSessionType } from "@/lib/audioPermissions";
import { Link } from "react-router-dom";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn' | 'youtube';
  audioUrl: string;
  album?: string;
  language?: string;
}

interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRating(score: number): { letter: string; color: string } {
  if (score >= 900) return { letter: 'L', color: 'text-score-perfect' };
  if (score >= 800) return { letter: 'S', color: 'text-score-perfect' };
  if (score >= 700) return { letter: 'A', color: 'text-score-great' };
  if (score >= 600) return { letter: 'B', color: 'text-score-good' };
  if (score >= 500) return { letter: 'C', color: 'text-score-ok' };
  if (score >= 300) return { letter: 'D', color: 'text-score-ok' };
  return { letter: 'F', color: 'text-score-miss' };
}

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ─── Save status mini-component ───────────────────────────────────────────────

function SaveStatus({
  status,
  onRetry,
}: {
  status: 'idle' | 'saving' | 'saved' | 'failed';
  onRetry: () => void;
}) {
  if (status === 'idle') return null;
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground min-h-[24px]">
      {status === 'saving' && <><Loader2 className="w-4 h-4 animate-spin" />Saving to leaderboard...</>}
      {status === 'saved' && <><Check className="w-4 h-4 text-green-500" />Saved to leaderboard</>}
      {status === 'failed' && (
        <><span>Could not save score</span>
          <button onClick={onRetry} className="underline hover:text-foreground transition-colors">Retry</button></>
      )}
    </div>
  );
}

// ─── Score breakdown ──────────────────────────────────────────────────────────

function ScoreBreakdown({
  totalScore,
  rating,
  accRef,
}: {
  totalScore: number;
  rating: { letter: string; color: string };
  accRef: React.MutableRefObject<{ accuracy: number; flow: number; expression: number; count: number }>;
}) {
  const { count, accuracy, flow, expression } = accRef.current;
  const avg = (v: number) => count > 0 ? Math.round(v / count) : 0;
  return (
    <>
      <p className={`text-8xl font-bold mb-4 animate-scale-in ${rating.color}`}>{rating.letter}</p>
      <p className="text-5xl font-bold text-gradient-gold mb-8">{totalScore}</p>
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Accuracy', weight: '50%', val: avg(accuracy) },
          { label: 'Flow', weight: '25%', val: avg(flow) },
          { label: 'Expression', weight: '25%', val: avg(expression) },
        ].map(({ label, weight, val }) => (
          <div key={label} className="text-center p-3 bg-muted/30 rounded-lg">
            <p className="text-xl font-semibold">{val}%</p>
            <p className="text-xs text-muted-foreground">{label} <span className="text-primary/70">({weight})</span></p>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const Sing = () => {
  const { trackId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, session } = useAuth();
  const { isDark } = useTheme();

  const [track, setTrack] = useState<Track | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [totalScore, setTotalScore] = useState(0);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [lyricsNotFound, setLyricsNotFound] = useState(false);
  const [vocalIntervals, setVocalIntervals] = useState<VocalInterval[] | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showPauseCheckpoint, setShowPauseCheckpoint] = useState(false);
  const [scoreSaveStatus, setScoreSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [guestName, setGuestName] = useState('');
  // Party context — parsed once on mount. When singing as part of a party,
  // the "signed-in user" is almost always the HOST, not the person actually
  // singing (everyone sings from the host's one device). So in party mode
  // we always need an explicit name for the singer, regardless of whether
  // the host is signed in. Pre-filled with the name they queued the song
  // under (singer_name from stage_queue), editable in case it's wrong.
  const [partyContext, setPartyContext] = useState<{
    code?: string; queueId?: string; singerName?: string; stageId?: string;
  } | null>(null);
  const [vocalsVolume, setVocalsVolume] = useState(40);
  const [vocalsEnabled, setVocalsEnabled] = useState(true);
  const [separationStartedAt, setSeparationStartedAt] = useState<number | null>(null);

  // Keep screen awake while playing
  useWakeLock(isPlaying);

  const trackDurationSecs = track?.duration ? parseDurationToSeconds(track.duration) ?? 0 : 0;

  // ── Refs ────────────────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const vocalsAudioRef = useRef<HTMLAudioElement | null>(null);
  const timeSyncRafRef = useRef<number | null>(null);
  const separationStartedAtRef = useRef<number | null>(null);
  const separationTriggeredRef = useRef<string | null>(null);
  const vocalAnalysisTriggeredRef = useRef<string | null>(null);
  const perTrackResetRef = useRef<string | null>(null);
  const lastCheckpointAtSecondsRef = useRef(0);
  const preEndTriggeredRef = useRef(false);
  const autoSaveTriggeredRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfirmLeaveRef = useRef<(() => void) | null>(null);
  const wasPlayingBeforeExitPromptRef = useRef(false);
  const vocalsEnabledRef = useRef(vocalsEnabled);
  const scoreAccumulatorRef = useRef({ accuracy: 0, flow: 0, expression: 0, count: 0 });

  useEffect(() => { vocalsEnabledRef.current = vocalsEnabled; }, [vocalsEnabled]);

  // Score weights: Accuracy 50%, Flow 25%, Expression 25%
  const SCORE_WEIGHTS = useRef({ pitch: 0.50, rhythm: 0.25, technique: 0.25 }).current;

  // ── Hooks ───────────────────────────────────────────────────────────────────
  const {
    isProcessing: isLoadingFromCache,
    separatedAudio,
    separateVocals: loadFromCache,
    activeTier,
  } = useVocalSeparation();

  const {
    isActive: isMicActive,
    metrics,
    error: micError,
    startAnalysis,
    stopAnalysis,
    resetAccumulators,
    setRefVolume,
  } = useVocalsComparison({
    vocalsUrl: separatedAudio?.vocalsUrl,
    currentTime,
    isPlaying,
  });

  const showAudioDebug = new URLSearchParams(window.location.search).get('debugAudio') === '1';
  const isTestPlayerMode = new URLSearchParams(window.location.search).has('testPlayer');

  // ── Audio session type ──────────────────────────────────────────────────────
  useEffect(() => { setAudioSessionType('play-and-record'); }, []);

  // ── MediaSession API ────────────────────────────────────────────────────────
  // MediaSession does NOT support volumechange — the spec deliberately excludes
  // it (volume is OS-level, not web-level). However, Android Chrome only routes
  // hardware volume keys to the correct audio stream (STREAM_MUSIC) when it
  // recognises an ACTIVE media session. The key signals are:
  //   1. metadata set (title, artist, artwork)
  //   2. playbackState = 'playing'
  //   3. setPositionState() called with current duration + position
  //   4. play/pause action handlers registered
  //
  // Without setPositionState(), Chrome may not fully claim audio focus, causing
  // Android to route volume keys to the ringer stream instead of media.
  // setPositionState only fires on meaningful state changes (not every RAF frame).
  useEffect(() => {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'KaraokeParty',
        artist: track.artist || '',
        album: 'KaraokeParty',
        artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

      // setPositionState tells Android exactly where we are in the track.
      // Only update on play/pause/track/duration changes, not every frame.
      if (duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position: Math.min(audioRef.current?.currentTime ?? 0, duration),
          });
        } catch { /* setPositionState not supported on all browsers */ }
      }

      // Register play/pause handlers so Android lock screen controls work
      navigator.mediaSession.setActionHandler('play', () => {
        audioRef.current?.play().catch(() => {});
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audioRef.current?.pause();
      });
    } catch (e) {
      console.warn('[audio] MediaSession sync failed:', e);
    }
  }, [track, isPlaying, duration]); // intentionally excludes currentTime

  // ── Load track + lyrics from sessionStorage ─────────────────────────────────
  useEffect(() => {
    const stored = sessionStorage.getItem('selectedTrack');
    if (!stored) { navigate('/'); return; }
    const parsed: Track = JSON.parse(stored);
    setTrack(parsed);

    // Party context — read once here (not re-parsed at submission time).
    // Pre-fill guestName with the singer's name from the queue so the field
    // isn't empty, but it stays fully editable if the host mis-typed it or
    // is now singing a different person's queued song.
    const partyRaw = sessionStorage.getItem('activePartyContext');
    if (partyRaw) {
      try {
        const partyParsed = JSON.parse(partyRaw);
        setPartyContext(partyParsed);
        if (partyParsed?.singerName) setGuestName(partyParsed.singerName);
      } catch { /* non-fatal — party mode name input still shows, just empty */ }
    }

    const prefetched = sessionStorage.getItem('prefetchedLyrics');
    if (prefetched) {
      try {
        const lines = JSON.parse(prefetched) as LyricLine[];
        if (lines?.length > 0) { setLyrics(lines); sessionStorage.removeItem('prefetchedLyrics'); return; }
      } catch { /* fall through */ }
      sessionStorage.removeItem('prefetchedLyrics');
    }
    fetchLyrics(parsed.title, parsed.artist, parsed.album, parsed.duration, parsed.language);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, navigate]);

  // ── Load separation from cache ──────────────────────────────────────────────
  useEffect(() => {
    if (isTestPlayerMode || !track?.audioUrl || separatedAudio || isLoadingFromCache) return;
    if (separationTriggeredRef.current === track.audioUrl) return;
    separationTriggeredRef.current = track.audioUrl;
    loadFromCache(track.audioUrl, 'fast', track.id, {
      title: track.title,
      artist: track.artist,
      durationSeconds: trackDurationSecs,
    });
  }, [track?.audioUrl, separatedAudio, isLoadingFromCache, loadFromCache, isTestPlayerMode]);

  // ── Per-track guard reset ───────────────────────────────────────────────────
  useEffect(() => {
    if (!track?.audioUrl || perTrackResetRef.current === track.audioUrl) return;
    perTrackResetRef.current = track.audioUrl;
    lastCheckpointAtSecondsRef.current = 0;
    setVocalIntervals(null);
  }, [track?.audioUrl]);

  // ── Vocal activity analysis for lyric highlight timing ─────────────────────
  // Caching of stems now happens server-side inside the separate-vocals edge
  // function (uploaded to Supabase Storage — a global cache shared by every
  // user, not per-browser IndexedDB). This client no longer fetches or saves
  // stem blobs at all — it only needs the vocals URL to time lyric highlights,
  // whether that URL came from a fresh Modal separation or a Storage cache hit.
  useEffect(() => {
    const vocalsUrl = separatedAudio?.vocalsUrl;
    if (!vocalsUrl || vocalAnalysisTriggeredRef.current === vocalsUrl) return;
    vocalAnalysisTriggeredRef.current = vocalsUrl;
    analyzeVocalActivity(vocalsUrl)
      .then(intervals => { if (intervals?.length) setVocalIntervals(intervals); })
      .catch(() => { /* non-fatal — lyric timing falls back to LRC timestamps */ });
  }, [separatedAudio?.vocalsUrl]);
  useEffect(() => {
    if (!track?.audioUrl) return;
    let isMounted = true;

    if (!separatedAudio) setIsPlayerReady(false);
    if (!separationStartedAtRef.current) {
      separationStartedAtRef.current = Date.now();
      setSeparationStartedAt(separationStartedAtRef.current);
    }
    setDuration(0);
    setCurrentTime(0);

    const audio = new Audio();
    audioRef.current = audio;
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';

    const stopTimeSync = () => {
      if (timeSyncRafRef.current != null) { cancelAnimationFrame(timeSyncRafRef.current); timeSyncRafRef.current = null; }
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
      if (!isMounted) return;
      console.log(`[sing] ready via ${reason}, duration:`, audio.duration);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(trackDurationSecs > 0 ? Math.min(audio.duration, trackDurationSecs) : audio.duration);
      }
      setIsPlayerReady(true);
    };

    const applyBlob = (blob: Blob) => {
      const b = blob.type === 'audio/mp4' ? blob : new Blob([blob], { type: 'audio/mp4' });
      const url = URL.createObjectURL(b);
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      objectUrlToRevoke = url;
      audio.src = url;
      audio.load();
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) markReady('blob-readyState');
    };

    audio.addEventListener('canplay', () => markReady('canplay'));
    audio.addEventListener('loadedmetadata', () => markReady('loadedmetadata'));

    audio.addEventListener('timeupdate', () => {
      if (!isMounted) return;
      setCurrentTime(audio.currentTime);
      // Drift correction between instrumental and vocals elements (~every 250ms)
      const vocals = vocalsAudioRef.current;
      if (vocals && vocalsEnabledRef.current && !vocals.paused && !audio.paused) {
        if (Math.abs(vocals.currentTime - audio.currentTime) > 0.2)
          vocals.currentTime = audio.currentTime;
      }
      // End at track duration (avoids MDX trailing silence)
      const effDur = trackDurationSecs > 0 ? Math.min(audio.duration || Infinity, trackDurationSecs) : audio.duration;
      if (effDur > 0 && audio.currentTime >= effDur - 0.5 && !audio.paused) {
        audio.pause(); setIsPlaying(false); stopTimeSync(); setShowResults(true);
      }
    });

    audio.addEventListener('play', () => { if (isMounted) { setIsPlaying(true); startTimeSync(); } });
    audio.addEventListener('pause', () => { if (isMounted) { setIsPlaying(false); stopTimeSync(); } });
    audio.addEventListener('ended', () => { if (isMounted) { setIsPlaying(false); stopTimeSync(); setShowResults(true); } });
    audio.addEventListener('error', () => {
      console.error('[sing] Audio error:', audio.error);
      if (isMounted) toast({ title: 'Audio error', description: 'Failed to load. Try another song.', variant: 'destructive' });
    });

    if (separatedAudio?.instrumentalUrl) {
      audio.src = separatedAudio.instrumentalUrl;
      audio.load();
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) markReady('separated-readyState');
    } else if (isTestPlayerMode && track?.audioUrl) {
      fetch(track.audioUrl)
        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
        .then(blob => { if (isMounted) applyBlob(blob); })
        .catch(async () => {
          if (!isMounted) return;
          const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/proxy-audio?url=${encodeURIComponent(track.audioUrl)}`;
          try {
            const r = await fetch(url, { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} });
            if (!r.ok) throw new Error(`proxy ${r.status}`);
            const blob = await r.blob();
            if (isMounted) applyBlob(blob);
          } catch (e) {
            if (isMounted) toast({ title: 'Audio error', description: 'Failed to load audio.', variant: 'destructive' });
          }
        });
    }
    // else: waiting for separatedAudio — effect re-runs when it arrives

    return () => {
      isMounted = false;
      stopTimeSync();
      audio.pause(); audio.src = '';
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      audioRef.current = null;
      stopAnalysis();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.audioUrl, separatedAudio?.instrumentalUrl, isTestPlayerMode, session?.access_token]);

  // Single source of truth for "should the vocals guide be silent right
  // now" -- used identically in all three places that touch this audio
  // element (creation, playback sync, volume sync). Previously each place
  // had its own slightly-different version of this check (some checked
  // vocalsEnabled only, some checked vocalsVolume === 0 only, some both).
  // Nothing enforced they could never disagree -- a real gap where, e.g.,
  // vocalsVolume could theoretically sit at 0 while vocalsEnabled was
  // still true, leaving the audio playing unmuted at effectively-zero
  // volume instead of guaranteed silent. Collapsing to one boolean means
  // there's no longer a seam for that kind of desync to hide in.
  const vocalsShouldBeSilent = !vocalsEnabled || vocalsVolume === 0;

  // ── Audible guide vocals element ────────────────────────────────────────────
  useEffect(() => {
    if (!separatedAudio?.vocalsUrl) {
      if (vocalsAudioRef.current) { vocalsAudioRef.current.pause(); vocalsAudioRef.current.src = ''; vocalsAudioRef.current = null; }
      return;
    }
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = separatedAudio.vocalsUrl;
    audio.preload = 'auto';
    audio.volume = vocalsShouldBeSilent ? 0 : vocalsVolume / 100;
    audio.muted = vocalsShouldBeSilent; // set on creation too, not just in the sync effect below --
                                         // defensive against any gap before that effect's first run
    vocalsAudioRef.current = audio;
    return () => { audio.pause(); audio.src = ''; vocalsAudioRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [separatedAudio?.vocalsUrl]);

  // Sync vocals playback with main player
  useEffect(() => {
    const audio = vocalsAudioRef.current;
    if (!audio || !separatedAudio?.vocalsUrl) return;
    // Checks vocalsShouldBeSilent now, not just vocalsEnabled -- guarantees
    // the audio element is actually PAUSED whenever it should be silent,
    // not just muted/zero-volume while technically still playing.
    if (isPlaying && !vocalsShouldBeSilent) {
      if (audioRef.current) audio.currentTime = audioRef.current.currentTime;
      // Ignore AbortError — it just means pause() was called before play() finished
      // Ignore NotAllowedError — vocals are supplementary, main audio still plays
      audio.play().catch(err => {
        if ((err as any)?.name !== 'AbortError' && (err as any)?.name !== 'NotAllowedError') {
          console.warn('[vocals] play() failed:', (err as any)?.name);
        }
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, vocalsShouldBeSilent, separatedAudio?.vocalsUrl]);

  // Sync vocals volume
  useEffect(() => {
    if (!vocalsAudioRef.current) return;
    vocalsAudioRef.current.volume = vocalsShouldBeSilent ? 0 : vocalsVolume / 100;
    vocalsAudioRef.current.muted = vocalsShouldBeSilent;
  }, [vocalsShouldBeSilent, vocalsVolume]);

  // ── Live score ──────────────────────────────────────────────────────────────
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  useEffect(() => {
    if (!isPlaying || !isMicActive) return;
    const handleMetrics = (m: typeof metrics) => {
      // Was only checking referenceActive. Inside useVocalsComparison the
      // EMAs correctly FREEZE (stop updating) when the user goes silent —
      // but this loop kept firing every 200ms regardless and re-adding
      // whatever the last frozen values were into the running average.
      // Result: sing well for a moment, then go silent for the rest of a
      // 4-minute song, and the score stays propped at that early peak
      // forever instead of reflecting that singing actually stopped.
      // Silence must contribute NOTHING — not even repeated stale credit.
      if (!m.referenceActive || !m.isVoiceDetected) return;
      scoreAccumulatorRef.current.accuracy   += m.pitchMatch;
      scoreAccumulatorRef.current.flow       += m.rhythmMatch;
      scoreAccumulatorRef.current.expression += m.techniqueMatch;
      scoreAccumulatorRef.current.count      += 1;
      const { accuracy, flow, expression, count } = scoreAccumulatorRef.current;
      const combined =
        (accuracy / count)   * SCORE_WEIGHTS.pitch +
        (flow / count)       * SCORE_WEIGHTS.rhythm +
        (expression / count) * SCORE_WEIGHTS.technique;
      setTotalScore(Math.max(0, Math.round(combined * 10)));
    };
    const id = setInterval(() => handleMetrics(metricsRef.current), 200);
    return () => clearInterval(id);
  }, [isPlaying, isMicActive, SCORE_WEIGHTS]);

  // ── Lyrics fetch ────────────────────────────────────────────────────────────
  const fetchLyrics = async (title: string, artist: string, album?: string, durationStr?: string, language?: string) => {
    const dur = parseDurationToSeconds(durationStr);
    setLyrics([]);
    const attempts = [
      { title, artist, album, duration: dur, language },
      { title, artist, duration: dur, language },
      { title, duration: dur, language },
    ];
    for (const params of attempts) {
      try {
        const data = await fetchLyricsCached(params);
        if (data?.lyrics?.length > 0) { setLyrics(data.lyrics); setLyricsNotFound(false); return; }
      } catch { /* try next */ }
    }
    setLyricsNotFound(true);
  };

  // ── Current lyric line ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!lyrics.length) return;
    const idx = lyrics.findIndex((line, i) => {
      const next = lyrics[i + 1];
      return currentTime >= line.time && (!next || currentTime < next.time);
    });
    setCurrentLineIndex(idx);
  }, [currentTime, lyrics]);

  // ── Seek ────────────────────────────────────────────────────────────────────
  const handleSeek = useCallback((t: number) => {
    if (audioRef.current) audioRef.current.currentTime = t;
    if (vocalsAudioRef.current) vocalsAudioRef.current.currentTime = t;
    setCurrentTime(t);
  }, []);

  // ── Play/Pause ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !isPlayerReady) return;

    if (isPlaying) {
      audio.pause();
      const elapsed = audio.currentTime - lastCheckpointAtSecondsRef.current;
      if (elapsed >= 30) {
        lastCheckpointAtSecondsRef.current = audio.currentTime;
        setShowPauseCheckpoint(true);
      }
      return;
    }

    setShowPauseCheckpoint(false);
    setShowExitConfirm(false);

    // If the audio context is suspended (common after pause on mobile),
    // it must be resumed before play() will succeed.
    // This silently fails on browsers that don't support AudioContext — non-fatal.
    try {
      const ctx = (audio as any)._audioCtx;
      if (ctx?.state === 'suspended') await ctx.resume();
    } catch { /* non-fatal */ }

    try {
      await audio.play();
    } catch (err) {
      const name = (err as any)?.name;

      // AbortError: play() was interrupted by pause() or another play() call
      // before it completed. This is not a real error — just retry once.
      if (name === 'AbortError') {
        try { await audio.play(); } catch { /* give up silently */ }
        return;
      }

      // NotAllowedError: browser blocked autoplay — user must tap again
      if (name === 'NotAllowedError') {
        toast({ title: 'Playback blocked', description: 'Tap Play again (browser requires a direct user action).', variant: 'destructive' });
        return;
      }

      // InvalidStateError: audio element is in a broken state (e.g. src was
      // revoked). Reload the src and retry.
      if (name === 'InvalidStateError' || name === 'NotSupportedError') {
        try {
          const src = audio.src;
          audio.load();
          audio.src = src;
          await audio.play();
        } catch {
          toast({ title: 'Playback failed', description: 'Unable to resume. Try restarting the song.', variant: 'destructive' });
        }
        return;
      }

      toast({ title: 'Playback failed', description: 'Unable to start playback. Try another song.', variant: 'destructive' });
      return;
    }

    if (!isMicActive) startAnalysis().catch(console.warn);
  }, [isPlaying, isPlayerReady, isMicActive, startAnalysis, toast]);

  const toggleMic = useCallback(async () => {
    if (isMicActive) stopAnalysis();
    else await startAnalysis();
  }, [isMicActive, startAnalysis, stopAnalysis]);

  const toggleVocals = useCallback(() => setVocalsEnabled(v => !v), []);

  const handleRestart = useCallback(() => {
    setCurrentTime(0);
    setTotalScore(0);
    scoreAccumulatorRef.current = { accuracy: 0, flow: 0, expression: 0, count: 0 };
    resetAccumulators();
    setShowResults(false);
    setShowExitConfirm(false);
    setShowPauseCheckpoint(false);
    lastCheckpointAtSecondsRef.current = 0;
    preEndTriggeredRef.current = false;
    autoSaveTriggeredRef.current = false;
    setScoreSaveStatus('idle');
    setGuestName('');
    separationStartedAtRef.current = null;
    setSeparationStartedAt(null);
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (vocalsAudioRef.current) vocalsAudioRef.current.currentTime = 0;
  }, [resetAccumulators]);

  // ── Score submission ────────────────────────────────────────────────────────
  const submitScoreToLeaderboard = useCallback(async () => {
    if (!track) return;
    setScoreSaveStatus('saving');
    try {
      const { accuracy, flow, count } = scoreAccumulatorRef.current;
      const avgAcc = Math.max(0, count > 0 ? accuracy / count : 0);
      const avgFlow = Math.max(0, count > 0 ? flow / count : 0);
      const scoreRating = totalScore >= 900 ? 'L' : totalScore >= 800 ? 'S' : totalScore >= 700 ? 'A'
        : totalScore >= 600 ? 'B' : totalScore >= 500 ? 'C' : totalScore >= 300 ? 'D' : 'F';

      // In party mode, always use the entered/pre-filled singer name —
      // NEVER the host's own signed-in identity. Everyone sings from the
      // host's one device, so "user is signed in" tells us nothing about
      // who's actually performing right now.
      const isPartyMode = !!partyContext;
      const displayName = isPartyMode
        ? (guestName.trim() || partyContext?.singerName || 'Guest')
        : (user && !user.is_anonymous)
          ? (user.user_metadata?.username || user.user_metadata?.full_name || 'Singer')
          : (guestName.trim() || 'Guest');

      const stageId = partyContext?.stageId ?? null;

      const { error } = await supabase.functions.invoke('submit-score', {
        body: {
          songTitle: track.title, songArtist: track.artist, trackId: track.id,
          score: totalScore, rating: scoreRating,
          timingAccuracy: Math.round(avgAcc), rhythmAccuracy: Math.round(avgFlow),
          durationSeconds: Math.round(duration), playedSeconds: Math.round(currentTime),
          thumbnailUrl: track.thumbnail, displayName, stageId,
          // ── Analytics telemetry — for future scoring calibration ───────────
          // These fields are stored but never affect the score displayed to
          // the user. They let us recalibrate constants from real data later.
          expressionAccuracy: count > 0 ? Math.round(scoreAccumulatorRef.current.expression / count) : 0,
          completionRatio: metrics.refActiveFrames > 0
            ? Math.round((metrics.voicedFrames / metrics.refActiveFrames) * 1000) / 1000
            : null,
          voicedFrames: metrics.voicedFrames,
          refActiveFrames: metrics.refActiveFrames,
          noiseFloor: metrics.noiseFloorSnapshot > 0
            ? Math.round(metrics.noiseFloorSnapshot * 10000) / 10000
            : null,
          trackSource: track.source,
          trackLanguage: track.language ?? null,
        },
      });
      if (error) throw error;
      setScoreSaveStatus('saved');

      if (partyContext?.queueId) {
        try {
          await supabase.from('stage_queue').update({ status: 'completed', score: totalScore, rating: scoreRating }).eq('id', partyContext.queueId);
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.error('[Score] Submit failed:', err);
      setScoreSaveStatus('failed');
    }
  }, [track, user, guestName, partyContext, totalScore, duration, currentTime]);

  // Auto-save on song completion.
  // Signed-in users normally auto-save instantly (their identity is trusted).
  // But in party mode that trust doesn't apply — the signed-in user is the
  // HOST, not necessarily who's singing. Give the same 5s grace period as
  // anonymous users so there's a chance to fix a wrong/missing singer name
  // before it's locked into the leaderboard.
  useEffect(() => {
    if (!showResults || autoSaveTriggeredRef.current) return;
    if (user && !partyContext) {
      autoSaveTriggeredRef.current = true;
      submitScoreToLeaderboard();
    } else {
      autoSaveTimerRef.current = setTimeout(() => {
        if (!autoSaveTriggeredRef.current) { autoSaveTriggeredRef.current = true; submitScoreToLeaderboard(); }
      }, 9000);
      return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
    }
  }, [showResults, submitScoreToLeaderboard, user, partyContext]);

  const handleManualSubmit = useCallback(() => {
    if (autoSaveTriggeredRef.current) return;
    autoSaveTriggeredRef.current = true;
    submitScoreToLeaderboard();
  }, [submitScoreToLeaderboard]);

  // ── Back/exit guards ────────────────────────────────────────────────────────
  const isMidPerformance = () => !showResults && (isPlaying || (currentTime > 0 && scoreAccumulatorRef.current.count > 0));

  const handleBackAttempt = useCallback((confirmLeave: () => void) => {
    if (isMidPerformance()) {
      wasPlayingBeforeExitPromptRef.current = isPlaying;
      if (isPlaying && audioRef.current) audioRef.current.pause();
      pendingConfirmLeaveRef.current = confirmLeave;
      setShowExitConfirm(true);
    } else {
      confirmLeave();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, showResults, currentTime]);

  useBackGuard(handleBackAttempt);
  useBeforeUnloadGuard(isMidPerformance);

  const handleLeaveWithScoreCheck = useCallback(() => {
    if (duration > 0 && currentTime / duration >= 0.7 && !autoSaveTriggeredRef.current) {
      autoSaveTriggeredRef.current = true;
      submitScoreToLeaderboard();
    }
    pendingConfirmLeaveRef.current?.();
  }, [duration, currentTime, submitScoreToLeaderboard]);

  const handleKeepSinging = useCallback(() => {
    setShowExitConfirm(false);
    if (wasPlayingBeforeExitPromptRef.current && audioRef.current) audioRef.current.play().catch(() => {});
  }, []);

  const handleNextClick = useCallback(() => {
    sessionStorage.removeItem('activePartyContext');
    if (partyContext?.code) { navigate(`/party/${partyContext.code}/stage`); return; }
    navigate('/');
  }, [navigate, partyContext]);

  // ── Share score card ────────────────────────────────────────────────────────
  const rating = getRating(totalScore);

  const generateScoreCardImage = useCallback((): Promise<Blob | null> => {
    return new Promise(resolve => {
      const W = 1080, H = 1080;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#1a0b2e'); bg.addColorStop(1, '#0a0612');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';

      ctx.fillStyle = '#f472b6'; ctx.font = 'bold 44px sans-serif'; ctx.fillText('KaraokeParty', W/2, 110);
      ctx.fillStyle = '#fff'; ctx.font = '34px sans-serif'; ctx.fillText((track?.title || '').slice(0, 40), W/2, 175);
      ctx.fillStyle = '#a1a1aa'; ctx.font = '26px sans-serif'; ctx.fillText((track?.artist || '').slice(0, 50), W/2, 215);

      const ratingColors: Record<string,string> = { L:'#facc15',S:'#facc15',A:'#4ade80',B:'#60a5fa',C:'#fb923c',D:'#fb923c',F:'#f87171' };
      ctx.fillStyle = ratingColors[rating.letter] || '#facc15';
      ctx.font = 'bold 280px sans-serif'; ctx.fillText(rating.letter, W/2, 540);
      ctx.fillStyle = '#facc15'; ctx.font = 'bold 100px sans-serif'; ctx.fillText(String(totalScore), W/2, 660);

      const { accuracy, flow, expression, count } = scoreAccumulatorRef.current;
      const avg = (v: number) => count > 0 ? Math.max(0, Math.round(v / count)) : 0;
      [
        { label: 'Accuracy', val: avg(accuracy) },
        { label: 'Flow', val: avg(flow) },
        { label: 'Expression', val: avg(expression) },
      ].forEach(({ label, val }, i) => {
        const cx = (W/3) * i + W/6;
        ctx.fillStyle = '#fff'; ctx.font = 'bold 46px sans-serif'; ctx.fillText(`${val}%`, cx, 760);
        ctx.fillStyle = '#a1a1aa'; ctx.font = '26px sans-serif'; ctx.fillText(label, cx, 800);
      });

      ctx.fillStyle = '#a1a1aa'; ctx.font = '30px sans-serif'; ctx.fillText('Think you can beat me?', W/2, 960);
      ctx.fillStyle = '#f472b6'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('karaokeparty.in', W/2, 1010);
      canvas.toBlob(resolve, 'image/png');
    });
  }, [rating, totalScore, track]);

  const handleShareScore = useCallback(async () => {
    const text = `I scored ${totalScore} (${rating.letter}) singing "${track?.title || 'a song'}" on KaraokeParty! Think you can beat me?`;
    const url = 'https://karaokeparty.in';
    try {
      const blob = await generateScoreCardImage();
      if (blob) {
        const file = new File([blob], 'karaokeparty-score.png', { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'My KaraokeParty Score', text }); return; }
      }
      if (navigator.share) { await navigator.share({ title: 'My KaraokeParty Score', text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast({ title: 'Copied to clipboard!', description: 'Paste anywhere to share.' });
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') toast({ title: 'Could not share', variant: 'destructive' });
    }
  }, [totalScore, rating, track, generateScoreCardImage, toast]);

  // ── Shared score breakdown (used by all 3 overlays) ─────────────────────────
  const scoreBreakdown = (
    <ScoreBreakdown totalScore={totalScore} rating={rating} accRef={scoreAccumulatorRef} />
  );

  const checkpointMessage = ['L','S','A'].includes(rating.letter)
    ? "You're on fire! 🔥"
    : ['B','C'].includes(rating.letter)
      ? "You're doing great! Let's continue"
      : "Keep going, you've got this!";

  // ── Singer name input ─────────────────────────────────────────────────────
  // Shows whenever we can't trust the signed-in user's identity as the
  // singer: either nobody is signed in, OR we're in party mode (host's own
  // account is irrelevant — everyone sings from the host's one device).
  const needsNameInput = !user || !!partyContext;
  const guestNameInput = needsNameInput && scoreSaveStatus === 'idle' ? (
    <div className="mb-4 flex flex-col items-center gap-1">
      {partyContext && (
        <p className="text-xs text-muted-foreground">Who's singing?</p>
      )}
      <input
        type="text"
        placeholder={partyContext ? 'Singer name' : 'Enter your name (optional)'}
        value={guestName}
        onChange={e => setGuestName(e.target.value)}
        onFocus={() => { if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; } }}
        maxLength={30}
        className="px-3 py-2 rounded-lg bg-white border-2 border-pink-500 text-foreground text-sm w-72 text-center placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  ) : null;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={`${isDark ? 'dark' : ''} h-[100dvh] bg-background flex flex-col overflow-hidden`}>

      {showAudioDebug && (
        <AudioDebugOverlay debug={{
          micActive: isMicActive, micError, volume: metrics.volume,
          voiceDetected: metrics.isVoiceDetected, referenceActive: metrics.referenceActive,
          voiceThreshold: metrics.debug?.voiceThreshold, noiseFloor: metrics.debug?.noiseFloor,
          audioCtxState: metrics.debug?.audioCtxState, micFallback: metrics.debug?.micFallback,
          userVolumeRmsFloat: metrics.debug?.userVolumeRmsFloat, userFreqEnergyDb: metrics.debug?.userFreqEnergyDb,
        }} />
      )}

      {/* ── Header ── */}
      <header className="glass border-b border-border px-3 py-2 flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="icon" onClick={() => handleBackAttempt(() => navigate('/'))}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold text-sm truncate">{track?.title || 'Loading...'}</h1>
          <p className="text-xs text-muted-foreground truncate">{track?.artist}</p>
        </div>
      </header>

      {/* ── Separation wait screen ──
          estimatedSeconds raised for both tiers -- the old values (30/50)
          were never realistic. Real Modal timings from Supabase edge
          function logs (all confirmed 'fast' tier: 56s, 57s, 72s, 82s,
          89s, 116s) cluster mostly around 60-90s, well above the old 30s
          fast-tier assumption. 60 is a directly data-backed choice for
          fast tier. Background tier's 75 is NOT directly measured the
          same way -- no background-tier timing logs were available when
          this was set -- scaled up proportionally from fast tier's real
          numbers on the assumption background (T4 GPU) is at least as
          slow as fast (A10G GPU), possibly slower. Worth correcting with
          real background-tier log data if/when available. */}
      <SeparationWaitScreen
        track={track}
        isVisible={!separatedAudio && !!track}
        startedAt={separationStartedAt}
        estimatedSeconds={activeTier === 'background' ? 75 : 60}
      />

      {/* ── End-of-song results overlay ── */}
      {showResults && (
        <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
          <button onClick={() => setShowResults(false)} aria-label="Close" className="absolute top-4 right-4 p-2 rounded-full text-muted-foreground hover:bg-muted/50 transition-colors">
            <X className="w-6 h-6" />
          </button>
          <div className="text-center max-w-md w-full">
            {scoreBreakdown}
            {guestNameInput}
            {scoreSaveStatus === 'idle' && (
              <div className="mb-4">
                <Button onClick={handleManualSubmit} size="sm" className="gradient-primary text-primary-foreground">
                  Submit Score
                </Button>
              </div>
            )}
            <SaveStatus status={scoreSaveStatus} onRetry={submitScoreToLeaderboard} />
            <div className="flex flex-wrap gap-3 justify-center mt-4">
              <Button variant="outline" size="sm" onClick={() => navigate('/')}>
                <Home className="w-4 h-4 mr-1" /> Home
              </Button>
              <Button variant="outline" size="sm" onClick={handleShareScore}>
                <Share2 className="w-4 h-4 mr-1" /> Share
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate('/leaderboard')}>
                <Trophy className="w-4 h-4 mr-1" /> Scores
              </Button>
              <Button size="sm" className="gradient-primary text-primary-foreground" onClick={handleRestart}>
                <RotateCcw className="w-4 h-4 mr-1" /> Again
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="mt-3" onClick={handleNextClick}>
              {partyContext ? 'Back to stage' : 'Done'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Exit-confirm overlay ── */}
      {showExitConfirm && (
        <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
          <div className="text-center max-w-md w-full">
            <p className="text-lg text-muted-foreground mb-4">Here's how you're doing so far</p>
            {scoreBreakdown}
            {guestNameInput}
            {scoreSaveStatus === 'idle' && (
              <div className="mb-4">
                <Button onClick={handleManualSubmit} size="sm" className="gradient-primary text-primary-foreground">Submit Score</Button>
              </div>
            )}
            <SaveStatus status={scoreSaveStatus} onRetry={submitScoreToLeaderboard} />
            <div className="flex gap-4 justify-center mt-4">
              <Button variant="outline" size="lg" onClick={handleKeepSinging}>Keep Singing</Button>
              <Button size="lg" variant="destructive" onClick={handleLeaveWithScoreCheck}>Leave</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pause checkpoint overlay ── */}
      {showPauseCheckpoint && (
        <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
          <div className="text-center max-w-md w-full">
            <p className="text-lg font-semibold mb-4">{checkpointMessage}</p>
            {scoreBreakdown}
            {guestNameInput}
            {scoreSaveStatus === 'idle' && (
              <div className="mb-4">
                <Button onClick={handleManualSubmit} size="sm" className="gradient-primary text-primary-foreground">Submit Score</Button>
              </div>
            )}
            <SaveStatus status={scoreSaveStatus} onRetry={submitScoreToLeaderboard} />
            <div className="flex gap-4 justify-center mt-4">
              <Button size="lg" className="gradient-primary text-primary-foreground" onClick={togglePlay}>
                <Play className="w-5 h-5 mr-2" /> Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lyrics ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 overflow-hidden min-h-0">
        <div className="w-full max-w-4xl flex flex-col items-center gap-4">
          {!isPlayerReady && lyrics.length === 0 && !lyricsNotFound ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3 animate-pulse">
                <Play className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">Loading audio...</p>
            </div>
          ) : lyricsNotFound ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-3">Lyrics not found</p>
              <button onClick={() => track && fetchLyrics(track.title, track.artist, track.album, track.duration, track.language)} className="text-sm text-primary underline underline-offset-4">
                Try again
              </button>
            </div>
          ) : lyrics.length === 0 ? (
            <div className="text-center py-8">
              <div className="animate-shimmer h-10 rounded-lg mb-3 w-64" />
              <div className="animate-shimmer h-10 rounded-lg mb-3 w-48" />
              <div className="animate-shimmer h-10 rounded-lg w-56" />
              <p className="text-muted-foreground mt-4 text-sm">Loading lyrics...</p>
            </div>
          ) : (
            lyrics.slice(Math.max(0, currentLineIndex - 1), currentLineIndex + 2).map((line, i) => {
              const actualIndex = Math.max(0, currentLineIndex - 1) + i;
              const isCurrent = actualIndex === currentLineIndex;
              const isPast = actualIndex < currentLineIndex;
              const nextLine = lyrics[actualIndex + 1];
              const lrcGap = nextLine ? Math.max(0.25, nextLine.time - line.time) : Math.max(0.25, duration - line.time);
              const effDur = vocalIntervals
                ? getLineSingingDuration(line.time, nextLine?.time ?? null, vocalIntervals, lrcGap)
                : (line.duration && line.duration > 0 ? line.duration : lrcGap);
              const lineProgress = isCurrent ? Math.min(1, Math.max(0, (currentTime - line.time) / effDur)) : isPast ? 1 : 0;
              const chars = [...line.text];
              const highlighted = isCurrent ? Math.floor(lineProgress * chars.length) : isPast ? chars.length : 0;

              return (
                <div key={actualIndex} className={`text-center transition-all duration-300 w-full ${
                  isCurrent
                    ? 'text-4xl md:text-5xl font-bold scale-100 opacity-100 leading-tight'
                    : 'text-2xl md:text-3xl opacity-50 scale-95 leading-tight'
                }`}>
                  {chars.map((char, ci) => (
                    <span key={ci} className={ci < highlighted ? (isPast ? 'text-primary/70' : 'text-primary') : 'text-muted-foreground'}>
                      {char}
                    </span>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Bottom panel: score + controls ── */}
      <div className="glass border-t border-border px-4 pt-3 pb-3 shrink-0">

        {/* Score row: metrics left | score centre | rating right */}
        <div className="flex items-end justify-between mb-3 max-w-4xl mx-auto">
          {isMicActive ? (
            <div className="flex flex-col gap-1 min-w-[56px]">
              {/* Live metrics EMAs hold their last value (by design) whenever
                  referenceActive/isVoiceDetected is false, so singing pauses
                  don't wipe out a good in-progress score. But that means
                  reading them unconditionally here can visibly show a
                  stale/held percentage before real singing has happened at
                  all, or during instrumental sections -- the same condition
                  already gating the score accumulator above must gate this
                  display too, so what's shown always matches what's
                  actually being scored. */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Acc</span>
                <span className="text-xs font-semibold text-blue-500">{(metrics.referenceActive && metrics.isVoiceDetected) ? metrics.pitchMatch : 0}%</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Flow</span>
                <span className="text-xs font-semibold text-green-500">{(metrics.referenceActive && metrics.isVoiceDetected) ? metrics.rhythmMatch : 0}%</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Expr</span>
                <span className="text-xs font-semibold text-purple-500">{(metrics.referenceActive && metrics.isVoiceDetected) ? metrics.techniqueMatch : 0}%</span>
              </div>
            </div>
          ) : <div className="min-w-[56px]" />}

          <p className="text-6xl font-bold text-gradient-gold leading-none text-center">{totalScore}</p>
          <div className={`text-5xl font-bold leading-none min-w-[40px] text-right ${rating.color}`}>{rating.letter}</div>
        </div>

        {/* Progress bar */}
        <div className="max-w-4xl mx-auto mb-3">
          <div
            className="h-1 bg-muted rounded-full cursor-pointer"
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); handleSeek((e.clientX - r.left) / r.width * duration); }}
          >
            <div className="h-full bg-primary rounded-full transition-none" style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
            <span>{fmtTime(currentTime)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between max-w-4xl mx-auto mb-3">
          <Button
            variant="outline" size="icon" onClick={toggleMic}
            className={`w-12 h-12 rounded-full ${isMicActive ? 'bg-primary text-primary-foreground border-primary' : ''}`}
          >
            {isMicActive ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </Button>
          <Button
            size="lg" onClick={togglePlay}
            disabled={!isPlayerReady || isLoadingFromCache || !separatedAudio}
            className="gradient-primary text-primary-foreground w-16 h-16 rounded-full disabled:opacity-50 shadow-lg"
          >
            {isLoadingFromCache ? <Loader2 className="w-7 h-7 animate-spin" /> : isPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7 ml-0.5" />}
          </Button>
          <Button variant="outline" size="icon" onClick={handleRestart} className="w-12 h-12 rounded-full">
            <RotateCcw className="w-5 h-5" />
          </Button>
        </div>

        {/* Vocals slider */}
        {separatedAudio && (
          <div className="flex items-center gap-3 max-w-4xl mx-auto">
            <button onClick={toggleVocals} className="shrink-0">
              <VocalsIcon className={`w-4 h-4 ${vocalsEnabled ? 'text-primary' : 'text-muted-foreground'}`} isActive={vocalsEnabled} />
            </button>
            <Slider
              value={[vocalsEnabled ? vocalsVolume : 0]}
              onValueChange={v => {
                setVocalsVolume(v[0]);
                if (v[0] > 0 && !vocalsEnabled) setVocalsEnabled(true);
                if (v[0] === 0 && vocalsEnabled) setVocalsEnabled(false);
              }}
              max={100} min={0} step={5}
              className="flex-1"
            />
            <span className="text-[10px] text-muted-foreground w-7 text-right shrink-0">
              {vocalsEnabled ? `${vocalsVolume}%` : 'Off'}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">Vocals</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default Sing;
