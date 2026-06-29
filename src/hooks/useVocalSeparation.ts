// =============================================================================
// CHANGELOG
// =============================================================================
// v1 -- Browser downloaded audio from Saavn then uploaded to Modal.
// v2 -- Parallel warmup + download.
// v3 -- URL-direct: Modal fetches from Saavn CDN server-side (<1s).
//
// v4 -- CURRENT: Optimized streaming-only mode.
//   REMOVED: prefetchAudio (browser was downloading 4-5MB from Saavn for
//     no reason -- Modal downloads from CDN at datacenter speed).
//   REMOVED: getAudioBlob, downloadTrack, parseHFResult, normalizeGradioFileUrl,
//     audioPrefetchCache -- all dead code from the old blob-upload path.
//   REMOVED: IndexedDB cache references (streaming mode has no blobs to cache).
//   FIXED: warmup staleness -- re-pings Modal if >3 min since last warmup.
//     Previously hfSpaceWarmedUp=true was permanent, so if the container
//     went cold after idle timeout, warmup was silently skipped.
//   GPU: batch_size 32->64, overlap 0.1->0.025 (in modal_app.py).
// =============================================================================

import { useState, useCallback, useRef } from 'react';
import { clearOldCache } from '@/lib/audioCache';
import { supabase } from '@/integrations/supabase/client';

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

const MODAL_URL = 'https://ajparag--vocal-separator-v3-vocalseparator-ui.modal.run';
const WARMUP_STALE_MS = 3 * 60 * 1000; // re-ping if >3 min since last warmup

let lastWarmupTs = 0;
let warmUpPromise: Promise<void> | null = null;

const separationPromiseCache = new Map<string, Promise<SeparationResult | null>>();

export async function warmUpHFSpace(): Promise<void> {
  // Re-ping if warmup is stale (container may have gone cold after idle timeout)
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
      if (data?.ready) {
        lastWarmupTs = Date.now();
        sepLog('WARMUP', `Modal awake in ${ms}ms`);
        sepStage('warmup', 'ok', `awake in ${ms}ms`);
      } else {
        // Container is booting but model not loaded yet.
        // Still set timestamp so we don't spam warmup calls.
        lastWarmupTs = Date.now();
        sepStage('warmup', 'warning', `ready=false (${ms}ms) -- container may still be loading`);
      }
    } catch (err) {
      sepWarn('WARMUP', `failed: ${err}`);
      sepStage('warmup', 'warning', String(err));
    } finally {
      warmUpPromise = null;
    }
  })();

  return warmUpPromise;
}

// Kept as export for backward compatibility with Index.tsx imports.
// No-op in streaming mode -- Modal downloads from Saavn CDN directly.
// The old version downloaded 4-5MB to the browser just to throw it away.
export async function prefetchAudio(_audioUrl: string): Promise<void> {
  // Trigger warmup if stale (the only useful side-effect of the old prefetch)
  warmUpHFSpace();
}

// =============================================================================
// SEPARATION HOOK
// =============================================================================

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (audioUrl: string): Promise<SeparationResult | null> => {
    setIsProcessing(true);
    setProgress('Starting AI separation...');
    setError(null);

    // Deduplicate: if separation already in-flight for this URL, attach to it
    const existing = separationPromiseCache.get(audioUrl);
    if (existing) {
      setProgress('AI vocal separation in progress...');
      const result = await existing;
      if (result) setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);
      return result;
    }

    let resolveShared!: (value: SeparationResult | null) => void;
    const shared = new Promise<SeparationResult | null>((resolve) => {
      resolveShared = resolve;
    });
    separationPromiseCache.set(audioUrl, shared);
    abortControllerRef.current = new AbortController();

    try {
      clearOldCache(7).catch(() => {});

      const t0 = Date.now();
      _currentSepUrl = audioUrl;
      _currentSepStartTs = t0;
      const elapsed = () => `+${Date.now() - t0}ms`;

      sepLog('SEP', `Separation started for: ${audioUrl.slice(0, 60)}`);
      sepStage('separation', 'pending', 'Modal downloading + GPU separating');

      // Call Modal /separate-by-url directly (browser -> Modal, CORS allowed
      // for karaokeparty.in). Modal downloads from Saavn CDN at datacenter
      // speed (~300ms) then runs GPU separation.
      setProgress('AI is separating vocals...');
      sepLog('SEP', `${elapsed()} Calling /separate-by-url...`);

      const resp = await fetch(`${MODAL_URL}/separate-by-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_url: audioUrl }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Separation failed: ${resp.status} ${errText.slice(0, 100)}`);
      }

      const json = await resp.json();
      const instUrl = json?.instrumental_url ? `${MODAL_URL}${json.instrumental_url}` : null;
      const vocUrl = json?.vocal_url ? `${MODAL_URL}${json.vocal_url}` : null;

      if (!instUrl) throw new Error('No instrumental URL returned');

      const secs = Math.round((Date.now() - t0) / 1000);
      sepLog('SEP', `${elapsed()} Done in ${secs}s (CDN download + GPU + streaming URLs)`);
      sepLog('SEP', `${elapsed()} Streaming mode -- returning Modal URLs`);
      sepStage('separation', 'ok', `done in ${secs}s`);
      sepStage('result', 'ok', 'streaming URLs ready');
      console.log('[VocalSeparation] Total time:', secs, 's');

      const result: SeparationResult = {
        instrumentalUrl: instUrl,
        vocalsUrl: vocUrl ?? undefined,
        fromCache: false,
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
      if (separationPromiseCache.get(audioUrl) === shared) {
        separationPromiseCache.delete(audioUrl);
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

  return { isProcessing, progress, error, separatedAudio, separateVocals, reset };
}
