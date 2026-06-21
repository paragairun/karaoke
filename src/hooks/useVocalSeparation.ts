// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Browser downloaded audio from Saavn then uploaded to Modal.
//   Total browser network overhead: ~9-13s before GPU even started.
//
// v2 — Parallel warmup + download (previous optimisation, kept).
//
// v3 — CURRENT: URL-direct mode — Modal fetches audio from Saavn server-side.
//   Instead of: browser downloads 6.7MB → browser uploads 6.7MB to Modal
//   Now:        browser sends the URL string → Modal fetches it at datacenter speed (<1s)
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

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
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
      console.log('[VocalSeparation] Waking Modal container...');
      const start = Date.now();
      const resp = await fetch(AAC_SPACE, { method: 'GET', cache: 'no-store' });
      if (resp.ok) {
        hfSpaceWarmedUp = true;
        console.log('[VocalSeparation] Modal awake in', Date.now() - start, 'ms');
      }
    } catch (err) {
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
      const cached = await getCachedTracks(cacheKey);
      if (cached) {
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
      const t = () => `+${Date.now() - separationStartTime}ms`;
      console.log('[TIMING] Separation started for:', audioUrl.slice(0, 60));

      const base = AAC_SPACE_BASE;

      // Warm up Modal in parallel — don't block on it
      warmUpHFSpace().catch(() => {});

      // ── URL-DIRECT MODE ──────────────────────────────────────────────────
      // Send the Saavn URL string directly to Modal as the predict payload.
      // app.py checks if input is a URL and fetches it server-side with
      // urllib.request — datacenter-speed download (<1s vs browser's 5-9s).
      // This eliminates both the browser download AND the browser upload step.
      // Falls back to the old upload method if URL mode fails.
      let eventId: string | null = null;

      setProgress('Sending to AI...');
      try {
        console.log(`[TIMING] ${t()} Trying URL-direct mode (no upload needed)...`);
        const urlDirectResp = await fetch(`${base}/gradio_api/call/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Send the URL string directly as the data payload.
          // app.py receives this as input_file and detects it is a URL.
          body: JSON.stringify({ data: [audioUrl] }),
        });
        if (urlDirectResp.ok) {
          const urlDirectJson = await urlDirectResp.json();
          eventId = urlDirectJson?.event_id ?? null;
          if (eventId) {
            console.log(`[TIMING] ${t()} URL-direct mode accepted, event_id: ${eventId}`);
          }
        }
      } catch (e) {
        console.warn('[VocalSeparation] URL-direct mode failed, falling back to upload:', e);
      }

      // ── FALLBACK: old upload method ───────────────────────────────────────
      if (!eventId) {
        console.log(`[TIMING] ${t()} Falling back to browser download + upload`);
        setProgress('Downloading audio...');
        const downloadStart = Date.now();
        const [audioBlob] = await Promise.all([
          getAudioBlob(audioUrl),
          Promise.resolve(), // warmup already started above
        ]);
        console.log(`[TIMING] ${t()} Audio downloaded: ${Math.round(audioBlob.size / 1024)}KB in ${Date.now() - downloadStart}ms`);

        const urlExt = audioUrl.split('?')[0].split('.').pop();
        const ext = (urlExt || 'm4a').toLowerCase();
        const safeExt = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext) ? ext : 'm4a';
        const mimeForExt: Record<string, string> = {
          mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
          flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
        };
        const fileName = `track.${safeExt}`;
        const audioFile = new File([audioBlob], fileName, { type: mimeForExt[safeExt] });

        setProgress('Uploading audio...');
        const uploadStart = Date.now();
        const fd = new FormData();
        fd.append('files', audioFile, fileName);
        const uploadResp = await fetch(`${base}/gradio_api/upload`, { method: 'POST', body: fd });
        if (!uploadResp.ok) throw new Error(`Audio upload failed: ${uploadResp.status} ${uploadResp.statusText}`);
        const uploadJson = (await uploadResp.json()) as string[];
        const serverPath = uploadJson?.[0];
        if (!serverPath) throw new Error('Upload returned no path');
        console.log(`[TIMING] ${t()} Uploaded in ${Date.now() - uploadStart}ms → ${serverPath}`);

        const fileData = {
          path: serverPath,
          orig_name: fileName,
          mime_type: audioFile.type,
          meta: { _type: 'gradio.FileData' },
        };

        setProgress('AI vocal separation in progress...');
        const fallbackCallResp = await fetch(`${base}/gradio_api/call/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [fileData] }),
        });
        if (!fallbackCallResp.ok) throw new Error(`Predict call failed: ${fallbackCallResp.status}`);
        const fallbackCallJson = await fallbackCallResp.json();
        eventId = fallbackCallJson?.event_id ?? null;
        if (!eventId) throw new Error('No event_id from predict call');
        console.log(`[TIMING] ${t()} Fallback upload predict queued, event_id: ${eventId}`);
      }

      // 2. Queue prediction result (shared between URL-direct and fallback)
      setProgress('AI vocal separation in progress...');
      const predictStart = Date.now();
      console.log(`[TIMING] ${t()} Waiting for GPU result...`);

      // 3. Stream SSE result
      const PREDICT_TIMEOUT = 4 * 60 * 1000;
      const sseController = new AbortController();
      const sseTimeout = setTimeout(() => sseController.abort(), PREDICT_TIMEOUT);

      let data: any = null;
      try {
        const sseResp = await fetch(`${base}/gradio_api/call/predict/${eventId}`, {
          method: 'GET',
          signal: sseController.signal,
        });
        if (!sseResp.ok || !sseResp.body) throw new Error(`SSE failed: ${sseResp.status}`);

        const reader = sseResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        outer: while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (currentEvent === 'complete') {
                try { data = JSON.parse(payload); } catch { data = payload; }
                break outer;
              } else if (currentEvent === 'error') {
                throw new Error(`Server error: ${payload}`);
              }
            }
          }
        }
      } finally {
        clearTimeout(sseTimeout);
      }

      console.log('[VocalSeparation] Predict complete in', Math.round((Date.now() - predictStart) / 1000), 's');
      if (!data) throw new Error('No data received from server');

      const { instrumentalUrl: instUrl, vocalsUrl: vocUrl } = parseHFResult(data, true);
      const finalInstUrl = instUrl || (Array.isArray(data) ? normalizeGradioFileUrl(data[0]) : null);
      if (!finalInstUrl) throw new Error('No instrumental URL found');

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

      saveCachedTracks(cacheKey, instrumentalBlob, vocalsBlob)
        .then(() => console.log('[VocalSeparation] Cached tracks saved'))
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
