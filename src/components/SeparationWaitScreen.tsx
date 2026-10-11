// src/components/SeparationWaitScreen.tsx
// =============================================================================
// CHANGELOG
// v1 — Initial: tips + song info modes, rotating cards, progress bar.
// v2 — Clean rewrite.
//   - Tips updated to reflect new scoring terms (Accuracy/Flow/Expression)
//   - Tip about vocals guide added (users don't know about the vocals slider)
//   - Song facts unchanged — still built from track data, no API calls
//   - Progress bar logic unchanged — high-water mark prevents regression
//   - Play count increments on mount (unchanged)
//   - Minor: ProgressBar and TickerCard extracted for readability
// v3 — CURRENT: feedback + failure state.
//   - After the screen has been up for 30 s (feedbackDelayMs) it asks
//     "Is the song loading OK?" with Yes / No (only when Sing.tsx passes
//     onFeedback, i.e. the song came from a search click). Asked once; the
//     answer goes to the song_attempts table via Sing.tsx.
//   - failedMessage: when separation fails the screen says so, with
//     "Try again" and "Pick another song", instead of the progress bar
//     creeping towards 95% forever.
//   - Layout: max-w-sm on phones, wider on large screens/TVs (lg/2xl), and
//     all buttons are real buttons with focus rings for keyboards/TV remotes.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Music2, Lightbulb, ChevronRight, AlertTriangle, RotateCcw, Search } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Track {
  title: string;
  artist: string;
  album?: string;
  thumbnail?: string;
  playCount?: number;
  duration?: string;
}

export type LoadingFeedback = "yes" | "no";

interface Props {
  track: Track | null;
  isVisible: boolean;
  estimatedSeconds?: number;
  startedAt: number | null;
  /** Separation failed: show this instead of the progress bar. */
  failedMessage?: string | null;
  onRetry?: () => void;
  onPickAnother?: () => void;
  /** Ask "Is the song loading OK?" after feedbackDelayMs; omitted = never ask. */
  onFeedback?: (answer: LoadingFeedback) => void;
  onPromptShown?: () => void;
  feedbackDelayMs?: number;
}

interface Card {
  icon: string;
  heading: string;
  body: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LS_KEY = "kp_play_count";
const TIPS_THRESHOLD = 3;
const TICK_MS = 7000;
const FEEDBACK_DELAY_MS = 30_000;

const TIPS: Card[] = [
  {
    icon: "🎤",
    heading: "Hold the mic right",
    body: "Keep your phone 15–20 cm from your mouth and don't cover the mic with your palm. A steady hold gives cleaner pitch readings.",
  },
  {
    icon: "🎵",
    heading: "How accuracy is scored",
    body: "Accuracy tracks how closely you match the original singer's notes. Land within a semitone and you're in great shape — the closer to dead-on, the higher the score.",
  },
  {
    icon: "🥁",
    heading: "How flow is scored",
    body: "Flow rewards you for starting and ending phrases at the right time. Breathe where the singer breathes — don't rush ahead or lag behind.",
  },
  {
    icon: "💪",
    heading: "How expression is scored",
    body: "Expression measures how steady and controlled your pitch is on held notes. Sing confidently and hold long notes all the way to the end.",
  },
  {
    icon: "🎶",
    heading: "Use the vocals guide",
    body: "The vocals slider at the bottom lets you hear the original singer alongside the instrumental. Turn it up while you're learning, down once you're confident.",
  },
  {
    icon: "✨",
    heading: "Pro tip",
    body: "Familiarity with the melody makes a huge difference — especially the high notes. If you know the song well, focus on matching the timing and sustaining your notes.",
  },
];

// ─── Song fact builder ────────────────────────────────────────────────────────

function buildSongFacts(track: Track): Card[] {
  const facts: Card[] = [];
  const artists = track.artist.split(/[,&]/).map(a => a.trim()).filter(Boolean);

  facts.push({
    icon: "🎙️",
    heading: artists.length === 1 ? "Singer" : "Artists",
    body: artists.length === 1
      ? `"${track.title}" is performed by ${artists[0]}.`
      : `This track features ${artists.slice(0, -1).join(", ")} and ${artists[artists.length - 1]}.`,
  });

  if (track.album) {
    facts.push({
      icon: "💿",
      heading: "Album",
      body: `"${track.title}" is from the album "${track.album}".`,
    });
  }

  if (track.playCount && track.playCount > 0) {
    const n = track.playCount;
    const playStr = n >= 100_000_000
      ? `${(n / 1_000_000).toFixed(0)} crore`
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)} million`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(0)}K`
          : n.toLocaleString();

    const label = n >= 10_000_000 ? "This is a massive hit"
      : n >= 1_000_000 ? "This song is very popular"
      : "This song has a solid fanbase";

    facts.push({
      icon: "🔥",
      heading: "Popularity",
      body: `${label} — "${track.title}" has been streamed ${playStr}+ times.`,
    });
  }

  if (track.duration) {
    facts.push({
      icon: "⏱️",
      heading: "Song length",
      body: `"${track.title}" runs for ${track.duration}. Get ready to sing from start to finish!`,
    });
  }

  facts.push({
    icon: "🏆",
    heading: "Your challenge",
    body: `Can you match ${artists[0] || "the original singer"}? Focus on the high notes and breathe at the right moments to maximise your score.`,
  });

  return facts;
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

function getPlayCount(): number {
  try { return parseInt(localStorage.getItem(LS_KEY) || "0", 10) || 0; }
  catch { return 0; }
}

function incrementPlayCount(): number {
  try {
    const next = getPlayCount() + 1;
    localStorage.setItem(LS_KEY, String(next));
    return next;
  } catch { return 1; }
}

// ─── ProgressBar ─────────────────────────────────────────────────────────────

function ProgressBar({ startedAt, estimatedSeconds }: { startedAt: number | null; estimatedSeconds: number }) {
  const [pct, setPct] = useState(0);
  const hwRef = useRef(0);

  useEffect(() => { hwRef.current = 0; setPct(0); }, [startedAt]);

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const raw = elapsed <= estimatedSeconds
        ? 0.90 * (elapsed / estimatedSeconds)
        : 0.90 + 0.05 * (1 - 1 / (1 + (elapsed - estimatedSeconds) / 30));
      const next = Math.round(raw * 100);
      if (next > hwRef.current) { hwRef.current = next; setPct(next); }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [startedAt, estimatedSeconds]);

  return (
    <div className="w-full mt-5 mb-1">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-muted-foreground font-medium tracking-wide uppercase">AI Processing</span>
        <span className="text-xs font-bold text-primary tabular-nums">{pct}%</span>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.7) 100%)" }}
        />
      </div>
    </div>
  );
}

// ─── TickerCard ───────────────────────────────────────────────────────────────

function TickerCard({ icon, heading, body, label }: Card & { label?: string }) {
  return (
    <div className="animate-fade-in w-full">
      {label && (
        <p className="text-xs font-semibold text-primary/70 uppercase tracking-widest mb-3">{label}</p>
      )}
      <div className="flex gap-3 items-start">
        <span className="text-3xl shrink-0 mt-0.5">{icon}</span>
        <div>
          <p className="font-semibold text-foreground text-base leading-snug mb-1">{heading}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
        </div>
      </div>
    </div>
  );
}

// ─── FeedbackPrompt ──────────────────────────────────────────────────────────

const PROMPT_BUTTON =
  "min-h-11 min-w-[5.5rem] px-5 rounded-full text-sm font-semibold transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function FeedbackPrompt({ state, onAnswer }: { state: "ask" | "thanks"; onAnswer: (a: LoadingFeedback) => void }) {
  return (
    <div role="group" aria-label="Is the song loading OK?" data-testid="loading-feedback"
      className="animate-fade-in w-full mt-4 rounded-xl border border-border bg-muted/40 px-4 py-3 text-center">
      {state === "ask" ? (
        <>
          <p className="text-sm font-medium text-foreground mb-2.5">Is the song loading OK?</p>
          <div className="flex justify-center gap-3">
            <button type="button" onClick={() => onAnswer("yes")}
              className={`${PROMPT_BUTTON} gradient-primary text-primary-foreground`}>Yes</button>
            <button type="button" onClick={() => onAnswer("no")}
              className={`${PROMPT_BUTTON} border border-border bg-background text-foreground hover:bg-muted`}>No</button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" role="status">Thanks for letting us know!</p>
      )}
    </div>
  );
}

// ─── FailurePanel ────────────────────────────────────────────────────────────

function FailurePanel({ message, onRetry, onPickAnother }: {
  message: string; onRetry?: () => void; onPickAnother?: () => void;
}) {
  return (
    <div role="alert" data-testid="separation-failed" className="animate-fade-in w-full mt-5 text-center">
      <AlertTriangle className="w-8 h-8 text-destructive mx-auto mb-2" aria-hidden />
      <p className="font-semibold text-foreground text-base">We couldn't prepare this song</p>
      <p className="text-sm text-muted-foreground mt-1">
        Please try again, or pick another song. Some songs can't be separated.
      </p>
      <p className="text-xs text-muted-foreground/60 mt-2 break-words">{message}</p>
      <div className="flex flex-col sm:flex-row justify-center gap-3 mt-5">
        {onRetry && (
          <button type="button" onClick={onRetry}
            className={`${PROMPT_BUTTON} gradient-primary text-primary-foreground inline-flex items-center justify-center gap-2`}>
            <RotateCcw className="w-4 h-4" aria-hidden /> Try again
          </button>
        )}
        {onPickAnother && (
          <button type="button" onClick={onPickAnother}
            className={`${PROMPT_BUTTON} border border-border bg-background text-foreground hover:bg-muted inline-flex items-center justify-center gap-2`}>
            <Search className="w-4 h-4" aria-hidden /> Pick another song
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// estimatedSeconds default raised 35 -> 20. Real Modal separation times
// (from Supabase edge function logs, both historical and current) cluster
// mostly in the 56-89s range, with occasional outliers past 100s -- 35s
// was never realistic. The progress bar climbs 0-90% over this estimate,
// then asymptotically crawls 90-95% waiting for the real completion signal
// (see ProgressBar below) -- with the old 35s value, EVERY separation hit
// that crawl phase almost immediately and stayed there for 20-80+ extra
// seconds, which read as "getting stuck near 90%." 20s keeps fast
// separations (~16-20s) landing right around completion as the bar nears
// 90%, while typical 70-90s cases now only spend 10-30s in the crawl zone
// instead of 35-55s. Doesn't fully fix the rare 100s+ outlier -- that
// would need a real progress signal from the backend, not just a better
// guess.
export function SeparationWaitScreen({
  track, isVisible, estimatedSeconds = 20, startedAt,
  failedMessage = null, onRetry, onPickAnother,
  onFeedback, onPromptShown, feedbackDelayMs = FEEDBACK_DELAY_MS,
}: Props) {
  const [mode, setMode] = useState<"tips" | "song_info">("tips");
  const [showTipsOverride, setShowTipsOverride] = useState(false);
  const [tickIndex, setTickIndex] = useState(0);
  const countedRef = useRef(false);
  // "ask" -> question visible; "thanks" -> answered; null -> not (yet) shown.
  const [prompt, setPrompt] = useState<null | "ask" | "thanks">(null);
  const promptDoneRef = useRef(false);
  const failed = !!failedMessage;

  // Ask once, after the screen has been up for feedbackDelayMs. Not while
  // showing a failure (we already know the answer then).
  useEffect(() => {
    if (!isVisible || failed || !onFeedback || promptDoneRef.current) return;
    const id = setTimeout(() => {
      promptDoneRef.current = true;
      setPrompt("ask");
      onPromptShown?.();
    }, feedbackDelayMs);
    return () => clearTimeout(id);
  }, [isVisible, failed, onFeedback, onPromptShown, feedbackDelayMs]);

  const answer = (a: LoadingFeedback) => {
    setPrompt("thanks");
    onFeedback?.(a);
  };

  const songFacts = track ? buildSongFacts(track) : [];

  useEffect(() => {
    if (!countedRef.current) {
      countedRef.current = true;
      const count = incrementPlayCount();
      setMode(count <= TIPS_THRESHOLD ? "tips" : "song_info");
    }
  }, []);

  useEffect(() => { if (isVisible) setTickIndex(0); }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    const id = setInterval(() => setTickIndex(i => i + 1), TICK_MS);
    return () => clearInterval(id);
  }, [isVisible]);

  const effectiveMode = showTipsOverride || mode === "tips" ? "tips" : "song_info";
  const items = effectiveMode === "tips" ? TIPS : songFacts;
  const current = items.length > 0 ? items[tickIndex % items.length] : null;

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/95 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-sm lg:max-w-md 2xl:max-w-lg mx-auto px-6 py-8 flex flex-col items-center">

        {/* Thumbnail */}
        <div className="w-full mb-4">
          <div className="w-full aspect-video rounded-xl overflow-hidden bg-muted relative">
            {track?.thumbnail
              ? <img src={track.thumbnail} alt={track.title} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center">
                  <Music2 className="w-10 h-10 text-muted-foreground" />
                </div>}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-3">
              <p className="font-bold text-white text-base leading-tight truncate drop-shadow">
                {track?.title || "Loading..."}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-sm text-white/80 truncate drop-shadow">{track?.artist}</p>
                {track?.playCount && track.playCount >= 1_000_000 && (
                  <p className="text-xs text-primary font-semibold shrink-0">
                    {(track.playCount / 1_000_000).toFixed(0)}M+ plays
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {failed ? (
          <FailurePanel message={failedMessage!} onRetry={onRetry} onPickAnother={onPickAnother} />
        ) : (
          <>
            <ProgressBar startedAt={startedAt} estimatedSeconds={estimatedSeconds} />

            {prompt && <FeedbackPrompt state={prompt} onAnswer={answer} />}

            {/* Ticker */}
            <div className="w-full min-h-[110px] flex items-start mt-5">
              {current && (
                <TickerCard
                  key={`${effectiveMode}-${tickIndex % items.length}`}
                  {...current}
                  label={effectiveMode === "tips" ? "Singing tip" : "Song story"}
                />
              )}
            </div>

            {/* Dot indicators */}
            <div className="flex gap-1.5 mt-4">
              {items.map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === tickIndex % items.length ? "bg-primary w-4" : "bg-muted-foreground/30 w-1.5"
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
                <Lightbulb className="w-3 h-3" /> Show tips
              </button>
            )}
            {showTipsOverride && mode === "song_info" && (
              <button
                onClick={() => { setShowTipsOverride(false); setTickIndex(0); }}
                className="mt-5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                <ChevronRight className="w-3 h-3" /> Back to song story
              </button>
            )}

            <p className="text-xs text-muted-foreground/50 mt-5 text-center">
              AI is separating vocals from the instrumental
            </p>
          </>
        )}
      </div>
    </div>
  );
}
