// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) -- Browser downloaded audio from Saavn then uploaded to Modal.
//   Total browser network overhead: ~9-13s before GPU even started.
//
// v2 -- Parallel warmup + download (previous optimisation, kept).
//
// v3 -- CURRENT: URL-direct mode -- Modal fetches audio from Saavn server-side.
//   Instead of: browser downloads 6.7MB -> browser uploads 6.7MB to Modal
//   Now:        browser sends the URL string -> Modal fetches it at datacenter speed (<1s)
//   Saves:      ~9-13s on every non-cached song
//
//   How it works:
//   - sendUrlToModal(url) sends the URL string directly as the Gradio data payload
//   - app.py detects it is a URL and fetches it server-side with urllib.request
//   - Falls back to old upload method if URL mode fails (backward compatible)
//   - prefetchAudio() still runs in parallel for the fallback path and for
//     pre-warming the browser cache in case the user re-uses a song
// =============================================================================

import { useState, useCallback, useRef } from 'react';
import { getCachedTracks, saveCachedTracks, clearOldCache } from '@/lib/audioCache';
import { supabase } from '@/integrations/supabase/client';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

// =============================================================================
// DIAGNOSTIC SYSTEM
// =============================================================================
// Run window.dumpSeparationDiagnostics() in browser console at any time
// to get a full snapshot of the current separation state.
// =============================================================================

type SepStageStatus = 'pending' | 'ok' | 'failed' | 'warning';
interface SepStageRecord { status: SepStageStatus; detail: string; ts: number; }

const SEP_STAGES = [
  'warmup',
  'cache_check',
  'audio_prefetch',
  'edge_fn_separate',
  'edge_fn_result',
  'stem_download',
  'indexeddb_save',
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

function sepError(tag: string, msg: string) {
  const entry = { ts: Date.now(), tag: `${tag}-ERROR`, msg };
  sepEventLog.push(entry);
  if (sepEventLog.length > SEP_LOG_MAX) sepEventLog.shift();
  console.error(`[${tag}] ${msg}`);
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


const audioPrefetchCache = new Map<string, { blob: Blob; timestamp: number }>();
const PREFETCH_CACHE_TTL = 5 * 60 * 1000;
const separationPromiseCache = new Map<string, Promise<SeparationResult | null>>();

let hfSpaceWarmedUp = false;
let hfWarmUpPromise: Promise<void> | null = null;

const AAC_SPACE = "https://ajparag--vocal-separator-v3-vocalseparator-ui.modal.run/";
const AAC_SPACE_BASE = AAC_SPACE.replace(/\/$/, '');
const SEPARATION_CACHE_VERSION = 'modal-v3-vocalseparator-aac-v1';

function getSeparationCacheKey(audioUrl: string) {
  return `${SEPARATION_CACHE_VERSION}:${audioUrl}`;
}

export async function warmUpHFSpace(): Promise<void> {
  if (hfSpaceWarmedUp) return Promise.resolve();
  if (hfWarmUpPromise) return hfWarmUpPromise;

  hfWarmUpPromise = (async () => {
    try {
      sepLog('WARMUP', 'Pinging Modal container via edge function');
      sepStage('warmup', 'pending', 'in progress');
      console.log('[VocalSeparation] Waking Modal container via edge function...');
      const start = Date.now();
      // Route through Supabase edge function -- direct browser->Modal is CORS-blocked.
      const { data } = await supabase.functions.invoke('separate-vocals', {
        body: { action: 'warmup' },
      });
      if (data?.ready) {
        hfSpaceWarmedUp = true;
        const ms = Date.now() - start;
        sepLog('WARMUP', `Modal awake in ${ms}ms`);
        sepStage('warmup', 'ok', `awake in ${ms}ms`);
        console.log('[VocalSeparation] Modal awake in', ms, 'ms');
      } else {
        sepStage('warmup', 'warning', 'ready=false from edge function');
      }
    } catch (err) {
      sepWarn('WARMUP', `failed: ${err}`);
      sepStage('warmup', 'warning', String(err));
      console.warn('[VocalSeparation] Warm-up failed (non-critical):', err);
    } finally {
      hfWarmUpPromise = null;
    }
  })();

  return hfWarmUpPromise;
}

export async function prefetchAudio(audioUrl: string): Promise<void> {
  warmUpHFSpace();
  const cached = audioPrefetchCache.get(audioUrl);
  if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) return;

  try {
    console.log('[VocalSeparation] Prefetching audio:', audioUrl.slice(0, 50));
    const response = await fetch(audioUrl);
    if (response.ok) {
      const blob = await response.blob();
      audioPrefetchCache.set(audioUrl, { blob, timestamp: Date.now() });
      console.log('[VocalSeparation] Audio prefetched:', Math.round(blob.size / 1024), 'KB');
    }
  } catch (err) {
    console.warn('[VocalSeparation] Prefetch failed:', err);
  }
}

async function getAudioBlob(audioUrl: string): Promise<Blob> {
  const cached = audioPrefetchCache.get(audioUrl);
  if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) {
    console.log('[VocalSeparation] Using prefetched audio');
    audioPrefetchCache.delete(audioUrl);
    return cached.blob;
  }
  console.log('[VocalSeparation] Downloading audio...');
  const response = await fetch(audioUrl);
  if (!response.ok) throw new Error(`Failed to fetch audio: ${response.statusText}`);
  return response.blob();
}

function parseHFResult(data: any, isAac: boolean): { instrumentalUrl: string | null; vocalsUrl: string | null } {
  let instrumentalUrl: string | null = null;
  let vocalsUrl: string | null = null;

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const url = normalizeGradioFileUrl(item);
        const origName = (item.orig_name || item.path || '').toLowerCase();
        const checkString = origName || (url || '').toLowerCase();

        if (checkString.includes('no_vocals') || checkString.includes('no-vocals') ||
          checkString.includes('instrumental') || checkString.includes('accompaniment') ||
          checkString.includes('other') || checkString.includes('music')) {
          instrumentalUrl = url;
        } else if (checkString.includes('vocals') || checkString.includes('voice')) {
          vocalsUrl = url;
        }
      }
    }

    if (data.length >= 2 && (!instrumentalUrl || !vocalsUrl)) {
      const url0 = normalizeGradioFileUrl(data[0]);
      const url1 = normalizeGradioFileUrl(data[1]);
      if (url0 && url1) {
        if (isAac) {
          vocalsUrl = vocalsUrl || url0;
          instrumentalUrl = instrumentalUrl || url1;
        } else {
          instrumentalUrl = instrumentalUrl || url0;
          vocalsUrl = vocalsUrl || url1;
        }
      }
    }
  }

  return { instrumentalUrl, vocalsUrl };
}

function normalizeGradioFileUrl(itemOrUrl: any): string | null {
  const rawUrl = typeof itemOrUrl === 'string' ? itemOrUrl : itemOrUrl?.url;
  const path = typeof itemOrUrl === 'object' ? itemOrUrl?.path : null;

  if (typeof path === 'string' && path.startsWith('/tmp/gradio/')) {
    return `${AAC_SPACE_BASE}/gradio_api/file=${path}`;
  }
  if (typeof rawUrl === 'string' && rawUrl.length > 0) {
    return rawUrl.replace('/g/gradio_api/file=', '/gradio_api/file=');
  }
  return null;
}

async function downloadTrack(url: string, label: string): Promise<Blob> {
  console.log(`[VocalSeparation] Downloading ${label} from:`, url.slice(0, 120));
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to download ${label}: ${response.status}`);
  const rawBlob = await response.blob();
  const blob = new Blob([rawBlob], { type: 'audio/mp4' });
  console.log(`[VocalSeparation] ${label}: ${Math.round(blob.size / 1024)}KB`);
  return blob;
}

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (audioUrl: string): Promise<SeparationResult | null> => {
    const cacheKey = getSeparationCacheKey(audioUrl);
    setIsProcessing(true);
    setProgress('Checking cache...');
    setError(null);

    // If separation already in-flight for this URL, attach to that promise
    const existingSeparation = separationPromiseCache.get(audioUrl);
    if (existingSeparation) {
      setProgress('AI vocal separation in progress...');
      const result = await existingSeparation;
      if (result) setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);
      return result;
    }

    let resolveSharedSeparation!: (value: SeparationResult | null) => void;
    const sharedSeparation = new Promise<SeparationResult | null>((resolve) => {
      resolveSharedSeparation = resolve;
    });
    separationPromiseCache.set(audioUrl, sharedSeparation);
    abortControllerRef.current = new AbortController();

    try {
      clearOldCache(7).catch(console.error);

      // IndexedDB cache check
      sepStage('cache_check', 'pending', 'checking IndexedDB');
      const cached = await getCachedTracks(cacheKey);
      if (cached) {
        sepStage('cache_check', 'ok', 'cache HIT -- skipping separation');
        setProgress('Loading from cache...');
        const instrumentalUrl = URL.createObjectURL(cached.instrumentalBlob);
        const vocalsUrl = cached.vocalsBlob ? URL.createObjectURL(cached.vocalsBlob) : undefined;
        const result: SeparationResult = { instrumentalUrl, vocalsUrl, fromCache: true };
        setSeparatedAudio(result);
        setProgress('');
        setIsProcessing(false);
        resolveSharedSeparation(result);
        return result;
      }

      const separationStartTime = Date.now();
      _currentSepUrl = audioUrl;
      _currentSepStartTs = separationStartTime;
      const t = () => `+${Date.now() - separationStartTime}ms`;
      sepLog('SEP', `Separation started for: ${audioUrl.slice(0, 60)}`);
      sepStage('cache_check', 'ok', 'cache MISS -- proceeding to separation');
      console.log('[TIMING] Separation started for:', audioUrl.slice(0, 60));

      // -- ALL MODAL CALLS GO THROUGH SUPABASE EDGE FUNCTION ----------------
      // Direct browser -> Modal is blocked by CORS (Modal returns no
      // Access-Control-Allow-Origin header for cross-origin browser requests).
      // Supabase edge function -> Modal is server-to-server: no CORS, full speed.
      //
      // Step 1: send audioUrl to edge function -> edge function passes URL
      //         string to Modal -> Modal fetches audio from Saavn at
      //         datacenter speed (<1s). No browser download or upload.
      // Step 2: edge function reads Modal SSE stream, returns stem URLs.
      // Step 3: browser downloads final stems (~12MB) from Modal directly.

      setProgress('Sending to AI...');
      sepLog('SEP', `${t()} Calling separate-vocals edge fn (download+upload)...`);
      sepStage('edge_fn_separate', 'pending', 'calling edge function');
      console.log(`[TIMING] ${t()} Sending audioUrl to separate-vocals edge function...`);

      const { data: separateData, error: separateError } = await supabase.functions.invoke(
        'separate-vocals',
        { body: { action: 'separate', audioUrl } }
      );

      if (separateError || !separateData?.eventId) {
        const errMsg = separateError?.message ?? JSON.stringify(separateData);
        sepError('SEP', `edge fn separate failed: ${errMsg}`);
        sepStage('edge_fn_separate', 'failed', errMsg);
        throw new Error(`Separation request failed: ${errMsg}`);
      }

      const eventId = separateData.eventId;
      sepLog('SEP', `${t()} Got event_id: ${eventId}`);
      sepStage('edge_fn_separate', 'ok', `event_id: ${eventId}`);
      console.log(`[TIMING] ${t()} Got event_id: ${eventId} -- polling for result...`);

      setProgress('AI vocal separation in progress...');
      const predictStart = Date.now();

      // Step 2: poll for result via edge function (handles SSE server-side)
      console.log(`[TIMING] ${t()} Calling result action...`);
      sepLog('SEP', `${t()} Polling for GPU result via edge fn...`);
      sepStage('edge_fn_result', 'pending', 'waiting for GPU separation');
      const { data: resultData, error: resultError } = await supabase.functions.invoke(
        'separate-vocals',
        { body: { action: 'result', eventId } }
      );

      if (resultError || (!resultData?.vocalUrl && !resultData?.instrumentalUrl)) {
        const errMsg = resultError?.message ?? JSON.stringify(resultData);
        sepError('SEP', `edge fn result failed: ${errMsg}`);
        sepStage('edge_fn_result', 'failed', errMsg);
        throw new Error(`Separation result failed: ${errMsg}`);
      }

      const gpuSecs = Math.round((Date.now() - predictStart) / 1000);
      sepLog('SEP', `${t()} GPU done in ${gpuSecs}s`);
      sepStage('edge_fn_result', 'ok', `completed in ${gpuSecs}s`);
      console.log(`[TIMING] ${t()} GPU + SSE done in ${gpuSecs}s`);

      // Build data shape that the existing download code below expects
      // vocalUrl and instrumentalUrl are the Modal file URLs
      const data: any = {
        vocalUrl: resultData.vocalUrl,
        instrumentalUrl: resultData.instrumentalUrl,
      };


      // data.instrumentalUrl and data.vocalUrl already extracted by edge function
      const finalInstUrl = data.instrumentalUrl ?? null;
      const vocUrl = data.vocalUrl ?? null;
      if (!finalInstUrl) throw new Error('No instrumental URL from edge function');

      console.log(`[TIMING] ${t()} Downloading stems...`);
      sepLog('SEP', `${t()} Downloading stems...`);
      sepStage('stem_download', 'pending', 'downloading vocal + instrumental');
      setProgress('Downloading separated tracks...');

      const [instrumentalBlob, vocalsBlob] = await Promise.all([
        downloadTrack(finalInstUrl, 'instrumental'),
        vocUrl ? downloadTrack(vocUrl, 'vocals').catch(e => {
          console.warn('[VocalSeparation] Vocals download failed:', e);
          return undefined;
        }) : Promise.resolve(undefined),
      ]);

      const instrumentalObjUrl = URL.createObjectURL(instrumentalBlob);
      const vocalsObjUrl = vocalsBlob ? URL.createObjectURL(vocalsBlob) : undefined;

      console.log('[VocalSeparation] Total time:', Math.round((Date.now() - separationStartTime) / 1000), 's');

      const separationResult: SeparationResult = {
        instrumentalUrl: instrumentalObjUrl,
        vocalsUrl: vocalsObjUrl,
        fromCache: false,
      };

      setSeparatedAudio(separationResult);
      setProgress('');
      setIsProcessing(false);

      sepLog('SEP', `${t()} Saving to IndexedDB...`);
      sepStage('stem_download', 'ok', `vocal=${Math.round((vocalsBlob?.size??0)/1024)}KB inst=${Math.round((instrumentalBlob?.size??0)/1024)}KB`);
      sepStage('indexeddb_save', 'pending', 'writing to IndexedDB');
      saveCachedTracks(cacheKey, instrumentalBlob, vocalsBlob)
        .then(() => {
          sepStage('indexeddb_save', 'ok', 'saved successfully');
          _currentSepStartTs = null;
          console.log('[VocalSeparation] Cached tracks saved');
        })
        .catch((err) => console.error('[VocalSeparation] Failed to cache:', err));

      resolveSharedSeparation(separationResult);
      return separationResult;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[VocalSeparation] Error:', message, err);
      setError(message);
      setProgress('');
      setIsProcessing(false);
      resolveSharedSeparation(null);
      return null;
    } finally {
      if (separationPromiseCache.get(audioUrl) === sharedSeparation) {
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
