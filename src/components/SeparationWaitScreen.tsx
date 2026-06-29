// src/components/SeparationWaitScreen.tsx
//
// CHANGELOG
// v1 — Waiting screen shown during AI vocal separation (~35s).
//      Two modes based on localStorage play count:
//      - TIPS (plays 1-3): rotating tips about scoring, mic, technique
//      - SONG_INFO (plays 4+): Claude-generated song trivia ticker
//      Progress bar runs throughout. "Show tips" button switches modes.
//      Falls back to TIPS if Claude returns no info or fails.
//      Play count increments when user lands on Sing page AND clicks play.

import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Music2, Trophy, Lightbulb, ChevronRight } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Track {
  title: string;
  artist: string;
  album?: string;
  thumbnail?: string;
  playCount?: number;
}

interface Props {
  track: Track | null;
  isVisible: boolean;          // true while separation is running
  estimatedSeconds?: number;   // default 35
  startedAt: number | null;    // Date.now() when separation began
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LS_KEY = "kp_play_count";
const TIPS_THRESHOLD = 3;        // show tips for first N plays
const TICK_INTERVAL_MS = 7000;   // each card shown for 7s

const TIPS: { icon: string; heading: string; body: string }[] = [
  {
    icon: "🎤",
    heading: "Hold the mic right",
    body: "Keep your phone 15–20 cm from your mouth and don't cover the mic with your palm. A steady hold gives cleaner pitch readings.",
  },
  {
    icon: "🎵",
    heading: "How pitch is scored",
    body: "Pitch tracks how closely you match the original singer's notes. Hit the note within 60 cents (half a semitone) and you score full marks for that phrase.",
  },
  {
    icon: "🥁",
    heading: "How rhythm is scored",
    body: "Rhythm rewards you for starting and ending phrases at the right time. Breathe where the singer breathes — don't rush ahead or lag behind.",
  },
  {
    icon: "💪",
    heading: "How technique is scored",
    body: "Technique measures your vocal energy and sustain. Sing out — don't mumble. Hold long notes all the way to the end instead of cutting them short.",
  },
  {
    icon: "✨",
    heading: "Pro tip",
    body: "Listen to the song once before you sing. Familiarity with the melody, especially the high notes, makes a huge difference to your score.",
  },
];

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

// ─── Claude song-info fetch ───────────────────────────────────────────────────

async function fetchSongFacts(title: string, artist: string): Promise<string[]> {
  const prompt = `Give me exactly 5 short, fascinating facts about the Bollywood song "${title}" by ${artist}.
Cover: the singer or composer, how the song was made or recorded, chart performance or records it broke, interesting trivia, and its cultural impact.
Return ONLY a valid JSON array of 5 strings. Each string must be 1-2 sentences. No markdown, no preamble, no keys — just the array.
Example format: ["Fact one here.", "Fact two here.", "Fact three here.", "Fact four here.", "Fact five here."]`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data = await resp.json();
  const text = data.content?.map((b: { type: string; text?: string }) => b.type === "text" ? b.text : "").join("") ?? "";
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty");
  return parsed.filter((s: unknown) => typeof s === "string" && s.length > 0);
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ startedAt, estimatedSeconds }: { startedAt: number | null; estimatedSeconds: number }) {
  const [pct, setPct] = useState(0);
  // Track the highest pct seen — progress bar must never go backward.
  // This prevents the bar from resetting if startedAt is briefly updated.
  const highWaterRef = useRef(0);

  useEffect(() => {
    if (!startedAt) return;
    // When startedAt changes, only reset highWater if the new startedAt is
    // earlier than the old one (i.e. a genuine new session, not a re-render).
    highWaterRef.current = 0;
  }, [startedAt]);

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      // Grows 0->95% over estimatedSeconds, then holds at 95%
      const raw = Math.min(0.95, elapsed / estimatedSeconds);
      const next = Math.round(raw * 100);
      // Never go backward
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
    <div className="w-full mt-6 mb-2">
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
            background: "linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.7) 100%)",
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
    <div className="animate-fade-in">
      {label && (
        <p className="text-xs font-semibold text-primary/70 uppercase tracking-widest mb-3">{label}</p>
      )}
      <div className="flex gap-3 items-start">
        <span className="text-3xl flex-shrink-0 mt-0.5">{icon}</span>
        <div>
          <p className="font-semibold text-foreground text-base leading-snug mb-1">{heading}</p>
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
  const [songFacts, setSongFacts] = useState<string[]>([]);
  const [factsLoading, setFactsLoading] = useState(false);
  const playCountRef = useRef<number>(0);
  const countedRef = useRef(false);

  // Increment play count once on mount
  useEffect(() => {
    if (!countedRef.current) {
      countedRef.current = true;
      const count = incrementPlayCount();
      playCountRef.current = count;
      setMode(count <= TIPS_THRESHOLD ? "tips" : "song_info");
    }
  }, []);

  // Fetch song facts when in song_info mode
  useEffect(() => {
    if (mode !== "song_info" || !track || factsLoading || songFacts.length > 0) return;
    setFactsLoading(true);
    fetchSongFacts(track.title, track.artist)
      .then(facts => {
        setSongFacts(facts);
        setFactsLoading(false);
      })
      .catch(() => {
        // Fall back to tips mode if Claude fails
        setShowTipsOverride(true);
        setFactsLoading(false);
      });
  }, [mode, track, factsLoading, songFacts.length]);

  // Ticker rotation
  useEffect(() => {
    if (!isVisible) return;
    const id = setInterval(() => {
      setTickIndex(i => i + 1);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isVisible]);

  const effectiveMode = (showTipsOverride || mode === "tips") ? "tips" : "song_info";
  const showSongInfo = effectiveMode === "song_info" && songFacts.length > 0;
  const showTips = effectiveMode === "tips" || (effectiveMode === "song_info" && !showSongInfo);

  // Current tip
  const tipItem = TIPS[tickIndex % TIPS.length];

  // Current song fact
  const factItem = showSongInfo ? songFacts[tickIndex % songFacts.length] : null;

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-auto px-6 py-8 flex flex-col items-center">

        {/* Song thumbnail — 16:9, full width, above title */}
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
            {/* Gradient overlay for legibility */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
            {/* Title overlay on thumbnail */}
            <div className="absolute bottom-0 left-0 right-0 p-3">
              <p className="font-bold text-white text-base leading-tight truncate drop-shadow">
                {track?.title || "Loading..."}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-sm text-white/80 truncate drop-shadow">{track?.artist}</p>
                {track?.playCount && track.playCount > 1_000_000 && (
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
        <div className="w-full min-h-[120px] flex items-start mt-6 relative">
          {/* Tips mode */}
          {showTips && (
            <TickerCard
              key={`tip-${tickIndex % TIPS.length}`}
              icon={tipItem.icon}
              heading={tipItem.heading}
              body={tipItem.body}
              label="Singing tip"
            />
          )}

          {/* Song info mode — loading */}
          {effectiveMode === "song_info" && factsLoading && (
            <TickerCard
              key="loading"
              icon="🎬"
              heading={`Did you know?`}
              body={`Loading interesting facts about "${track?.title}"...`}
              label="Song story"
            />
          )}

          {/* Song info mode — facts */}
          {showSongInfo && factItem && (
            <TickerCard
              key={`fact-${tickIndex % songFacts.length}`}
              icon="🎬"
              heading="Did you know?"
              body={factItem}
              label="Song story"
            />
          )}
        </div>

        {/* Dot indicators */}
        <div className="flex gap-1.5 mt-5">
          {(showTips ? TIPS : songFacts).map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                i === tickIndex % (showTips ? TIPS.length : songFacts.length)
                  ? "bg-primary w-4"
                  : "bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>

        {/* Switch to tips button (only in song_info mode) */}
        {effectiveMode === "song_info" && !showTipsOverride && (
          <button
            onClick={() => setShowTipsOverride(true)}
            className="mt-6 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <Lightbulb className="w-3 h-3" />
            Show tips
          </button>
        )}

        {/* Back to song info (if tips override is active) */}
        {showTipsOverride && mode === "song_info" && songFacts.length > 0 && (
          <button
            onClick={() => setShowTipsOverride(false)}
            className="mt-6 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <ChevronRight className="w-3 h-3" />
            Back to song story
          </button>
        )}

        <p className="text-xs text-muted-foreground/50 mt-6 text-center">
          AI is separating vocals from the instrumental
        </p>
      </div>
    </div>
  );
}
