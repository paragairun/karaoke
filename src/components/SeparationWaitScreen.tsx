// src/components/SeparationWaitScreen.tsx
//
// CHANGELOG
// v1 — Waiting screen shown during AI vocal separation (~35s).
//      Two modes based on localStorage play count:
//      - TIPS (plays 1-3): rotating tips about scoring, mic, technique
//      - SONG_INFO (plays 4+): song facts derived from Saavn track data
//      No external API calls — all data comes from the track object already
//      available at render time. Progress bar runs throughout.
//      "Show tips" button lets returning users switch to tips for that session.
//      Play count increments on mount (landing on Sing page).

import { useEffect, useRef, useState } from "react";
import { Music2, Lightbulb, ChevronRight } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Track {
  title: string;
  artist: string;
  album?: string;
  thumbnail?: string;
  playCount?: number;
  duration?: string;
}

interface Props {
  track: Track | null;
  isVisible: boolean;
  estimatedSeconds?: number;
  startedAt: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LS_KEY = "kp_play_count";
const TIPS_THRESHOLD = 3;
const TICK_INTERVAL_MS = 7000;

const TIPS: { icon: string; heading: string; body: string }[] = [
  {
    icon: "🎤",
    heading: "Hold the mic right",
    body: "Keep your phone 15-20 cm from your mouth and don't cover the mic with your palm. A steady hold gives cleaner pitch readings.",
  },
  {
    icon: "🎵",
    heading: "How pitch is scored",
    body: "Pitch tracks how closely you match the original singer's notes. Hit the note within half a semitone and you score full marks for that phrase.",
  },
  {
    icon: "🥁",
    heading: "How rhythm is scored",
    body: "Rhythm rewards you for starting and ending phrases at the right time. Breathe where the singer breathes -- don't rush ahead or lag behind.",
  },
  {
    icon: "💪",
    heading: "How technique is scored",
    body: "Technique measures your vocal energy and sustain. Sing out -- don't mumble. Hold long notes all the way to the end instead of cutting them short.",
  },
  {
    icon: "✨",
    heading: "Pro tip",
    body: "Listen to the song once before you sing. Familiarity with the melody, especially the high notes, makes a huge difference to your score.",
  },
];

// ─── Build song fact cards from Saavn track data ──────────────────────────────

function buildSongFacts(track: Track): { icon: string; heading: string; body: string }[] {
  const facts: { icon: string; heading: string; body: string }[] = [];

  // Artist / singer fact
  const artists = track.artist
    .split(/[,&]/)
    .map(a => a.trim())
    .filter(Boolean);
  if (artists.length === 1) {
    facts.push({
      icon: "🎙️",
      heading: "Singer",
      body: `"${track.title}" is performed by ${artists[0]}.`,
    });
  } else {
    facts.push({
      icon: "🎙️",
      heading: "Artists",
      body: `This track features ${artists.slice(0, -1).join(", ")} and ${artists[artists.length - 1]}.`,
    });
  }

  // Album fact
  if (track.album) {
    facts.push({
      icon: "💿",
      heading: "Album",
      body: `"${track.title}" is from the album "${track.album}".`,
    });
  }

  // Play count fact
  if (track.playCount && track.playCount > 0) {
    let playStr = "";
    if (track.playCount >= 100_000_000) {
      playStr = `${(track.playCount / 1_000_000).toFixed(0)} crore`;
    } else if (track.playCount >= 1_000_000) {
      playStr = `${(track.playCount / 1_000_000).toFixed(1)} million`;
    } else if (track.playCount >= 1_000) {
      playStr = `${(track.playCount / 1_000).toFixed(0)}K`;
    } else {
      playStr = track.playCount.toLocaleString();
    }

    const label =
      track.playCount >= 10_000_000
        ? "This is a massive hit"
        : track.playCount >= 1_000_000
        ? "This song is very popular"
        : "This song has a solid fanbase";

    facts.push({
      icon: "🔥",
      heading: "Popularity",
      body: `${label} -- "${track.title}" has been streamed ${playStr}+ times on JioSaavn.`,
    });
  }

  // Duration fact
  if (track.duration) {
    facts.push({
      icon: "⏱️",
      heading: "Song length",
      body: `"${track.title}" runs for ${track.duration}. Get ready to sing from start to finish!`,
    });
  }

  // Singing challenge fact
  facts.push({
    icon: "🏆",
    heading: "Your challenge",
    body: `Can you match ${artists[0] || "the original singer"}? Focus on the high notes and breathe at the right moments to maximise your score.`,
  });

  return facts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPlayCount(): number {
  try {
    return parseInt(localStorage.getItem(LS_KEY) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

function incrementPlayCount(): number {
  try {
    const next = getPlayCount() + 1;
    localStorage.setItem(LS_KEY, String(next));
    return next;
  } catch {
    return 1;
  }
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({
  startedAt,
  estimatedSeconds,
}: {
  startedAt: number | null;
  estimatedSeconds: number;
}) {
  const [pct, setPct] = useState(0);
  const highWaterRef = useRef(0);

  useEffect(() => {
    highWaterRef.current = 0;
    setPct(0);
  }, [startedAt]);

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const raw = Math.min(0.95, elapsed / estimatedSeconds);
      const next = Math.round(raw * 100);
      if (next > highWaterRef.current) {
        highWaterRef.current = next;
        setPct(next);
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [startedAt, estimatedSeconds]);

  return (
    <div className="w-full mt-5 mb-1">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-muted-foreground font-medium tracking-wide uppercase">
          AI Processing
        </span>
        <span className="text-xs font-bold text-primary tabular-nums">{pct}%</span>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background:
              "linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.7) 100%)",
          }}
        />
      </div>
    </div>
  );
}

// ─── Ticker card ──────────────────────────────────────────────────────────────

function TickerCard({
  icon,
  heading,
  body,
  label,
}: {
  icon: string;
  heading: string;
  body: string;
  label?: string;
}) {
  return (
    <div className="animate-fade-in w-full">
      {label && (
        <p className="text-xs font-semibold text-primary/70 uppercase tracking-widest mb-3">
          {label}
        </p>
      )}
      <div className="flex gap-3 items-start">
        <span className="text-3xl flex-shrink-0 mt-0.5">{icon}</span>
        <div>
          <p className="font-semibold text-foreground text-base leading-snug mb-1">
            {heading}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SeparationWaitScreen({
  track,
  isVisible,
  estimatedSeconds = 35,
  startedAt,
}: Props) {
  const [mode, setMode] = useState<"tips" | "song_info">("tips");
  const [showTipsOverride, setShowTipsOverride] = useState(false);
  const [tickIndex, setTickIndex] = useState(0);
  const countedRef = useRef(false);

  // Derive song facts immediately from track — no API call needed
  const songFacts = track ? buildSongFacts(track) : [];

  // Increment play count once on mount
  useEffect(() => {
    if (!countedRef.current) {
      countedRef.current = true;
      const count = incrementPlayCount();
      setMode(count <= TIPS_THRESHOLD ? "tips" : "song_info");
    }
  }, []);

  // Reset ticker when visibility changes
  useEffect(() => {
    if (isVisible) setTickIndex(0);
  }, [isVisible]);

  // Ticker rotation
  useEffect(() => {
    if (!isVisible) return;
    const id = setInterval(() => {
      setTickIndex(i => i + 1);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isVisible]);

  const effectiveMode =
    showTipsOverride || mode === "tips" ? "tips" : "song_info";
  const items = effectiveMode === "tips" ? TIPS : songFacts;
  const currentItem = items.length > 0 ? items[tickIndex % items.length] : null;
  const dotCount = items.length;

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-auto px-6 py-8 flex flex-col items-center">

        {/* Song thumbnail 16:9 with title overlay */}
        <div className="w-full mb-4">
          <div className="w-full aspect-video rounded-xl overflow-hidden bg-muted shadow-lg relative">
            {track?.thumbnail ? (
              <img
                src={track.thumbnail}
                alt={track.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Music2 className="w-10 h-10 text-muted-foreground" />
              </div>
            )}
            {/* Gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
            {/* Title overlay */}
            <div className="absolute bottom-0 left-0 right-0 p-3">
              <p className="font-bold text-white text-base leading-tight truncate drop-shadow">
                {track?.title || "Loading..."}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-sm text-white/80 truncate drop-shadow">
                  {track?.artist}
                </p>
                {track?.playCount && track.playCount >= 1_000_000 && (
                  <p className="text-xs text-primary font-semibold shrink-0">
                    {(track.playCount / 1_000_000).toFixed(0)}M+ plays
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <ProgressBar startedAt={startedAt} estimatedSeconds={estimatedSeconds} />

        {/* Ticker area */}
        <div className="w-full min-h-[110px] flex items-start mt-5">
          {currentItem && (
            <TickerCard
              key={`${effectiveMode}-${tickIndex % items.length}`}
              icon={currentItem.icon}
              heading={currentItem.heading}
              body={currentItem.body}
              label={effectiveMode === "tips" ? "Singing tip" : "Song story"}
            />
          )}
        </div>

        {/* Dot indicators */}
        <div className="flex gap-1.5 mt-4">
          {Array.from({ length: dotCount }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === tickIndex % dotCount
                  ? "bg-primary w-4"
                  : "bg-muted-foreground/30 w-1.5"
              }`}
            />
          ))}
        </div>

        {/* Mode toggle */}
        {mode === "song_info" && !showTipsOverride && (
          <button
            onClick={() => { setShowTipsOverride(true); setTickIndex(0); }}
            className="mt-5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <Lightbulb className="w-3 h-3" />
            Show tips
          </button>
        )}
        {showTipsOverride && mode === "song_info" && (
          <button
            onClick={() => { setShowTipsOverride(false); setTickIndex(0); }}
            className="mt-5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <ChevronRight className="w-3 h-3" />
            Back to song story
          </button>
        )}

        <p className="text-xs text-muted-foreground/50 mt-5 text-center">
          AI is separating vocals from the instrumental
        </p>
      </div>
    </div>
  );
}
