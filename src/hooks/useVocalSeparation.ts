// =============================================================================
// CHANGELOG
// =============================================================================
// v1-v5 -- Streaming mode: browser called Modal's /separate-by-url directly.
//   MODAL_API_KEY was hardcoded in this client-side file -- visible to
//   anyone via dev tools or view-source. Each browser also cached results
//   locally in IndexedDB, so the same song got separated by Modal's GPU
//   once per unique device, even for songs thousands of people had already
//   sung.
//
// v6 -- CURRENT: All separation now goes through the `separate-vocals`
//   Supabase Edge Function. This file no longer talks to Modal at all, and
//   no longer touches IndexedDB.
//   - Modal's API key lives only in the edge function now.
//   - The edge function checks Supabase Storage (a GLOBAL cache shared by
//     every user, not per-browser) before calling Modal. First person to
//     sing a song pays the GPU cost; everyone after gets an instant public
//     Storage URL back.
//   - REMOVED: getCachedTracks/clearOldCache imports (audioCache.ts is no
//     longer used by this file -- caching is now server-side).
//   - REMOVED: MODAL_URL_FAST/MODAL_URL_BACKGROUND/MODAL_API_KEY constants.
//   - The in-flight promise dedup cache (separationPromiseCache) is KEPT --
//     it still matters for preventing duplicate simultaneous edge function
//     calls from the same browser tab (e.g. a party host singing while
//     background pre-separation races for the same track).
//
// v7 -- CURRENT: real timing for the wait-screen progress bar.
//   - separateVocals() accepts the optional 4th `songMeta` argument that
//     Index.tsx and Sing.tsx were already passing (it was silently dropped,
//     and was the source of the "Expected 1-3 arguments, but got 4" type
//     error). Only durationSeconds is used, client-side, for timing.
//   - Every FRESH separation (not a Storage cache hit) records its actual
//     end-to-end time via recordSeparationTiming(), so the estimate in
//     lib/separationEstimate.ts self-corrects per device.
//   - warmUpModal() now remembers how long the ping took. A slow ping means
//     the Modal container was cold-starting -> getModalWarmState().
//   - In-flight entries remember when they started ->
//     getInFlightSeparationStart(), so Sing.tsx's bar starts at the real
//     start (Index.tsx kicks separation off BEFORE navigating to Sing).
// =============================================================================

import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { recordSeparationTiming } from '@/lib/separationEstimate';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

// =============================================================================
// DIAGNOSTIC SYSTEM
// Run window.dumpSeparationDiagnostics() in browser console at any time.
// =============================================================================

type SepStageStatus = 'pending' | 'ok' | 'failed' | 'warning';
interface SepStageRecord { status: SepStageStatus; detail: string; ts: number; }

const SEP_STAGES = [
  'warmup',
  'separation',
  'result',
] as const;
type SepStage = typeof SEP_STAGES[number];

const sepStageTracker = new Map<SepStage, SepStageRecord>();
const sepEventLog: Array<{ ts: number; tag: string; msg: string }> = [];
const SEP_LOG_MAX = 100;

function sepStage(stage: SepStage, status: SepStageStatus, detail: string) {
  sepStageTracker.set(stage, { status, detail, ts: Date.now() });
}

function sepLog(tag: string, msg: string) {
  const entry = { ts: Date.now(), tag, msg };
  sepEventLog.push(entry);
  if (sepEventLog.length > SEP_LOG_MAX) sepEventLog.shift();
  console.log(`[${tag}] ${msg}`);
}

function sepWarn(tag: string, msg: string) {
  const entry = { ts: Date.now(), tag: `${tag}-WARN`, msg };
  sepEventLog.push(entry);
  if (sepEventLog.length > SEP_LOG_MAX) sepEventLog.shift();
  console.warn(`[${tag}] ${msg}`);
}

let _currentSepUrl: string | null = null;
let _currentSepStartTs: number | null = null;

function dumpSeparationDiagnostics() {
  const lines: string[] = [];
  lines.push('===========================================================');
  lines.push('VOCAL SEPARATION DIAGNOSTICS -- ' + new Date().toISOString());
  lines.push('===========================================================');

  lines.push('-- PIPELINE STAGES --');
  for (const stage of SEP_STAGES) {
    const rec = sepStageTracker.get(stage);
    if (!rec) {
      lines.push(`  [?] ${stage}: never reached`);
    } else {
      const icon = rec.status === 'ok' ? '[ok]' : rec.status === 'failed' ? '[x]'
        : rec.status === 'warning' ? '[!] ' : '[~]';
      const age = ((Date.now() - rec.ts) / 1000).toFixed(1);
      lines.push(`  ${icon} ${stage}: ${rec.detail} (${age}s ago)`);
    }
  }

  lines.push('-- CURRENT SESSION --');
  lines.push(`  audioUrl: ${_currentSepUrl ? _currentSepUrl.slice(0, 70) : 'none'}`);
  lines.push(`  elapsed: ${_currentSepStartTs ? ((Date.now() - _currentSepStartTs) / 1000).toFixed(1) + 's' : 'not running'}`);

  lines.push(`-- LAST ${Math.min(sepEventLog.length, 30)} EVENTS --`);
  for (const e of sepEventLog.slice(-30)) {
    const t = new Date(e.ts).toISOString().split('T')[1].replace('Z', '');
    lines.push(`  ${t} [${e.tag}] ${e.msg}`);
  }

  lines.push('===========================================================');
  const report = lines.join('');
  console.log(report);
  return report;
}

if (typeof window !== 'undefined') {
  (window as any).dumpSeparationDiagnostics = dumpSeparationDiagnostics;
}

// =============================================================================
// WARMUP
// =============================================================================
// Still goes through the edge function's "warmup" action -- unchanged from
// before, this never exposed the API key client-side to begin with.

export type SeparationTier = 'fast' | 'background';
const WARMUP_STALE_MS = 1 * 60 * 1000; // re-ping if >1 min since last warmup

let lastWarmupTs = 0;
let warmUpPromise: Promise<void> | null = null;
// How long the most recent warmup ping took, and whether Modal said ready.
// A warm container answers in ~1s (prod log: 1033ms); a cold one only
// answers after container boot + model load.
let lastWarmupMs = 0;
let lastWarmupReady = false;
const COLD_PING_MS = 5000;
// Modal scales the container down after 120s idle (scaledown_window), so a
// warmup result older than that says nothing about the container now.
const WARM_STATE_VALID_MS = 120 * 1000;

export type ModalWarmState = 'warm' | 'cold' | 'unknown';

export function getModalWarmState(): ModalWarmState {
  if (warmUpPromise) return 'unknown';
  if (!lastWarmupTs || Date.now() - lastWarmupTs > WARM_STATE_VALID_MS) return 'unknown';
  return lastWarmupMs > COLD_PING_MS || !lastWarmupReady ? 'cold' : 'warm';
}

// Resolves when any in-flight warmup ping finishes (immediately if none).
export function waitForWarmup(): Promise<void> {
  return warmUpPromise ?? Promise.resolve();
}

interface InFlightSeparation {
  promise: Promise<SeparationResult | null>;
  tier: SeparationTier;
  startedAt: number;
}
const separationPromiseCache = new Map<string, InFlightSeparation>();

// When the separation for this track actually started, if one is in flight.
export function getInFlightSeparationStart(trackId: string | undefined | null): number | null {
  if (!trackId) return null;
  return separationPromiseCache.get(trackId)?.startedAt ?? null;
}

export interface SongMeta {
  title?: string;
  artist?: string;
  durationSeconds?: number;
}

export async function warmUpModal(): Promise<void> {
  if (lastWarmupTs > 0 && Date.now() - lastWarmupTs < WARMUP_STALE_MS) return;
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    try {
      sepLog('WARMUP', 'Pinging Modal container via edge function');
      sepStage('warmup', 'pending', 'in progress');
      const start = Date.now();
      const { data } = await supabase.functions.invoke('separate-vocals', {
        body: { action: 'warmup' },
      });
      const ms = Date.now() - start;
      lastWarmupMs = ms;
      lastWarmupReady = !!data?.ready;
      if (data?.ready) {
        lastWarmupTs = Date.now();
        sepLog('WARMUP', `Modal awake in ${ms}ms`);
        sepStage('warmup', 'ok', `awake in ${ms}ms`);
      } else {
        lastWarmupTs = Date.now();
        sepStage('warmup', 'warning', `ready=false (${ms}ms) -- container may still be loading`);
      }
    } catch (err) {
      lastWarmupReady = false;
      sepWarn('WARMUP', `failed: ${err}`);
      sepStage('warmup', 'warning', String(err));
    } finally {
      warmUpPromise = null;
    }
  })();

  return warmUpPromise;
}

// =============================================================================
// SEPARATION HOOK
// =============================================================================

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const [activeTier, setActiveTier] = useState<SeparationTier>('fast');
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (
    audioUrl: string,
    tier: SeparationTier = 'fast',
    trackId?: string,
    songMeta?: SongMeta,
  ): Promise<SeparationResult | null> => {
    // trackId is required now -- it's the Storage cache key server-side.
    // Falls back to a hash-free slice of audioUrl only in the unlikely case
    // a caller doesn't have one yet, but every real call site passes it.
    const cacheKey = trackId ?? audioUrl;
    setIsProcessing(true);
    setProgress('Starting AI separation...');
    setError(null);

    // Deduplicate FIRST, before any await. Same rationale as before: two
    // callers for the same track (e.g. party pre-separation + the singer's
    // own Play tap) must share one in-flight edge function call, not fire
    // two separate ones.
    const existing = separationPromiseCache.get(cacheKey);
    if (existing) {
      setActiveTier(existing.tier);
      setProgress('AI vocal separation in progress...');
      const result = await existing.promise;
      if (result) setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);
      return result;
    }

    setActiveTier(tier);
    let resolveShared!: (value: SeparationResult | null) => void;
    const shared = new Promise<SeparationResult | null>((resolve) => {
      resolveShared = resolve;
    });
    separationPromiseCache.set(cacheKey, { promise: shared, tier, startedAt: Date.now() });
    abortControllerRef.current = new AbortController();

    try {
      const t0 = Date.now();
      _currentSepUrl = audioUrl;
      _currentSepStartTs = t0;
      const elapsed = () => `+${Date.now() - t0}ms`;

      sepLog('SEP', `Separation requested for: ${audioUrl.slice(0, 60)}`);
      sepStage('separation', 'pending', 'edge function checking Storage cache / calling Modal');
      sepLog('SEP', `Using ${tier.toUpperCase()} tier`);

      // Single call to the edge function. It internally checks the global
      // Storage cache first, and only calls Modal on a genuine miss --
      // this hook has no visibility into (or need to know) which happened.
      const { data, error: fnError } = await supabase.functions.invoke('separate-vocals', {
        body: { action: 'separate', audioUrl, trackId: cacheKey, tier },
      });

      if (fnError) throw new Error(fnError.message || 'Separation request failed');
      if (data?.error) throw new Error(data.error);
      if (!data?.instrumentalUrl) throw new Error('No instrumental URL returned');

      const secs = Math.round((Date.now() - t0) / 1000);
      sepLog('SEP', `${elapsed()} Done in ${secs}s (fromCache: ${!!data.fromCache})`);
      sepStage('separation', 'ok', `done in ${secs}s${data.fromCache ? ' (Storage cache hit)' : ' (fresh Modal separation)'}`);
      sepStage('result', 'ok', 'Storage URLs ready');
      console.log('[VocalSeparation] Total time:', secs, 's', data.fromCache ? '(cached)' : '(fresh)');

      // Teach the wait-screen estimator from real fresh-separation times.
      // Warmup has always settled by now (a warm ping is ~1s; a cold ping
      // finishes when the container is up, before separation can).
      if (!data.fromCache) {
        const cold = getModalWarmState() === 'cold';
        const learned = recordSeparationTiming({
          songSeconds: songMeta?.durationSeconds,
          tier,
          cold,
          totalSeconds: (Date.now() - t0) / 1000,
        });
        if (learned) {
          sepLog('SEP', `Timing learned (${cold ? 'cold' : 'warm'}, ${tier}): rate=${learned.rate[tier].toFixed(4)} s/s, coldExtra=${learned.coldExtra.toFixed(1)}s, samples=${learned.samples}`);
        }
      }

      const result: SeparationResult = {
        instrumentalUrl: data.instrumentalUrl,
        vocalsUrl: data.vocalsUrl ?? undefined,
        fromCache: !!data.fromCache,
      };

      setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);
      _currentSepStartTs = null;

      resolveShared(result);
      return result;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[VocalSeparation] Error:', message, err);
      setError(message);
      setProgress('');
      setIsProcessing(false);
      resolveShared(null);
      return null;
    } finally {
      if (separationPromiseCache.get(cacheKey)?.promise === shared) {
        separationPromiseCache.delete(cacheKey);
      }
      abortControllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    setIsProcessing(false);
    setProgress('');
    setError(null);
    setSeparatedAudio(null);
  }, []);

  return { isProcessing, progress, error, separatedAudio, separateVocals, reset, activeTier };
}
