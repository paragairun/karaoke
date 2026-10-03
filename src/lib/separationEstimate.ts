// src/lib/separationEstimate.ts
// =============================================================================
// Estimates how long a FRESH vocal separation will take, so the wait-screen
// progress bar tracks reality instead of a hard-coded 60s/75s guess.
//
// Model:  seconds = OVERHEAD + rate[tier] * songSeconds + (cold ? coldExtra : 0)
//
// Seeds come from production logs (2026-10-02, after the Modal speed pass):
//   Warm A10G run, 320s song: Modal 15.6s (decode 0.4 + load 0.16 + GPU 8.66
//   + writes 5.93, all of which scale with song length), browser saw 23.2s
//   end to end. ~7s of that is edge function + Storage upload + network.
//   -> OVERHEAD 7s, fast rate 0.05 s per audio-second (7 + 0.05*320 = 23s).
//
// NOT measured, explicitly assumptions until real samples correct them:
//   - Background tier (T4) rate: seeded at 2x the A10G rate.
//   - coldExtra (container boot + model load): seeded at 8s. Model load alone
//     logged 2.83s; container boot time isn't in any log we have.
//
// Learning: after every fresh separation (never a Storage cache hit), the
// observed end-to-end time updates the tier's rate (warm runs) or coldExtra
// (cold runs) by exponential moving average, stored per device in
// localStorage. Bad/odd samples are rejected or clamped so one outlier can't
// wreck the estimate.
// =============================================================================

export type EstimateTier = 'fast' | 'background';

const LS_KEY = 'kp_sep_timing_v1';
const OVERHEAD_S = 7;
const DEFAULT_SONG_S = 270;        // used when the song length is unknown
const EMA_ALPHA = 0.3;             // weight of the newest sample
const MIN_ESTIMATE_S = 8;

interface TimingModel {
  rate: Record<EstimateTier, number>;  // seconds of processing per second of audio
  coldExtra: number;                   // extra seconds when the container was cold
  samples: number;
}

const SEED: TimingModel = {
  rate: { fast: 0.05, background: 0.10 },
  coldExtra: 8,
  samples: 0,
};

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function loadTimingModel(): TimingModel {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...SEED, rate: { ...SEED.rate } };
    const p = JSON.parse(raw);
    return {
      rate: {
        fast: Number.isFinite(p?.rate?.fast) ? p.rate.fast : SEED.rate.fast,
        background: Number.isFinite(p?.rate?.background) ? p.rate.background : SEED.rate.background,
      },
      coldExtra: Number.isFinite(p?.coldExtra) ? p.coldExtra : SEED.coldExtra,
      samples: Number.isFinite(p?.samples) ? p.samples : 0,
    };
  } catch {
    return { ...SEED, rate: { ...SEED.rate } };
  }
}

function saveTimingModel(m: TimingModel) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { /* private mode etc. */ }
}

export function estimateSeparationSeconds(opts: {
  songSeconds?: number | null;
  tier: EstimateTier;
  cold: boolean;
  model?: TimingModel;
}): number {
  const m = opts.model ?? loadTimingModel();
  const song = opts.songSeconds && opts.songSeconds > 0 ? opts.songSeconds : DEFAULT_SONG_S;
  const est = OVERHEAD_S + m.rate[opts.tier] * song + (opts.cold ? m.coldExtra : 0);
  return Math.max(MIN_ESTIMATE_S, Math.round(est));
}

// Call ONLY for fresh separations (fromCache === false).
export function recordSeparationTiming(opts: {
  songSeconds?: number | null;
  tier: EstimateTier;
  cold: boolean;
  totalSeconds: number;
}): TimingModel | null {
  const song = opts.songSeconds ?? 0;
  const total = opts.totalSeconds;
  // Reject samples we can't learn from reliably.
  if (!(song >= 30 && song <= 1200)) return null;
  if (!(total >= 3 && total <= 300)) return null;

  const m = loadTimingModel();
  if (opts.cold) {
    const warmPart = OVERHEAD_S + m.rate[opts.tier] * song;
    const sample = clamp(total - warmPart, 0, 90);
    m.coldExtra = m.coldExtra * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
  } else {
    const sample = clamp((total - OVERHEAD_S) / song, 0.01, 0.5);
    m.rate[opts.tier] = m.rate[opts.tier] * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
  }
  m.samples += 1;
  saveTimingModel(m);
  return m;
}
