import { useState, useCallback, useRef } from 'react';
import { getCachedTracks, saveCachedTracks, clearOldCache } from '@/lib/audioCache';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

// Audio prefetch cache - stores downloaded blobs before separation starts
const audioPrefetchCache = new Map<string, { blob: Blob; timestamp: number }>();
const PREFETCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const separationPromiseCache = new Map<string, Promise<SeparationResult | null>>();

// Track if HF space has been warmed up this session
let hfSpaceWarmedUp = false;
let hfWarmUpPromise: Promise<void> | null = null;

// Vocal separation endpoints (Gradio-compatible)
const AAC_SPACE = "https://ajparag--vocal-separator-v3-ui.modal.run/";
const AAC_SPACE_BASE = AAC_SPACE.replace(/\/$/, '');

// Warm up HuggingFace space proactively (non-blocking, singleton)
export async function warmUpHFSpace(): Promise<void> {
  if (hfSpaceWarmedUp) return Promise.resolve();
  if (hfWarmUpPromise) return hfWarmUpPromise;

  hfWarmUpPromise = (async () => {
    try {
      console.log('[VocalSeparation] Waking Modal container...');
      const start = Date.now();
      // Modal scales to zero; a plain GET wakes the container.
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

// Prefetch audio in background (called on track hover/click)
export async function prefetchAudio(audioUrl: string): Promise<void> {
  warmUpHFSpace();

  const cached = audioPrefetchCache.get(audioUrl);
  if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) {
    return;
  }

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

// Get prefetched audio or download fresh
async function getAudioBlob(audioUrl: string): Promise<Blob> {
  const cached = audioPrefetchCache.get(audioUrl);
  if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) {
    console.log('[VocalSeparation] Using prefetched audio');
    audioPrefetchCache.delete(audioUrl);
    return cached.blob;
  }

  console.log('[VocalSeparation] Downloading audio...');
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.statusText}`);
  }
  return response.blob();
}

// Connect to HF space with retry
async function connectToHFSpace(): Promise<{ client: any; spaceId: string; isAac: boolean }> {
  // Try AAC space first
  try {
    console.log('[VocalSeparation] Connecting to', AAC_SPACE);
    const client = await Client.connect(AAC_SPACE);
    console.log('[VocalSeparation] Connected to AAC space');
    return { client, spaceId: AAC_SPACE, isAac: true };
  } catch (err) {
    console.warn('[VocalSeparation] AAC space failed, trying WAV fallback:', err);
  }

  // Fallback to WAV space
  try {
    console.log('[VocalSeparation] Connecting to', WAV_SPACE_PRIMARY);
    const client = await Client.connect(WAV_SPACE_PRIMARY);
    console.log('[VocalSeparation] Connected to WAV space');
    return { client, spaceId: WAV_SPACE_PRIMARY, isAac: false };
  } catch (err) {
    throw new Error('Failed to connect to any HF space');
  }
}

// Parse separation result from HF space
function parseHFResult(data: any, isAac: boolean): { instrumentalUrl: string | null; vocalsUrl: string | null } {
  let instrumentalUrl: string | null = null;
  let vocalsUrl: string | null = null;

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const url = item.url as string;
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

    // Positional fallback
    if (data.length >= 2 && (!instrumentalUrl || !vocalsUrl)) {
      const getUrl = (item: any) => typeof item === 'string' ? item : item?.url;
      const url0 = getUrl(data[0]);
      const url1 = getUrl(data[1]);
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

// Download a track from HF URL
async function downloadTrack(url: string, label: string): Promise<Blob> {
  console.log(`[VocalSeparation] Downloading ${label} from:`, url.slice(0, 120));
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status}`);
  }
  const contentType = response.headers.get('content-type');
  const blob = await response.blob();
  console.log(`[VocalSeparation] === ${label.toUpperCase()} DOWNLOAD ===`);
  console.log(`[VocalSeparation] ${label} size: ${Math.round(blob.size / 1024)}KB (${blob.size} bytes)`);
  console.log(`[VocalSeparation] ${label} content-type: ${contentType}`);
  console.log(`[VocalSeparation] ${label} blob.type: ${blob.type}`);
  return blob;
}

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (audioUrl: string): Promise<SeparationResult | null> => {
    setIsProcessing(true);
    setProgress('Checking cache...');
    setError(null);

    abortControllerRef.current = new AbortController();

    try {
      // Clear old cache entries in background
      clearOldCache(7).catch(console.error);

      // Check IndexedDB cache first
      const cached = await getCachedTracks(audioUrl);
      if (cached) {
        setProgress('Loading from cache...');
        const instrumentalUrl = URL.createObjectURL(cached.instrumentalBlob);
        const vocalsUrl = cached.vocalsBlob ? URL.createObjectURL(cached.vocalsBlob) : undefined;

        const result: SeparationResult = { instrumentalUrl, vocalsUrl, fromCache: true };
        setSeparatedAudio(result);
        setProgress('');
        setIsProcessing(false);
        return result;
      }

      // === CLIENT-SIDE SEPARATION via direct Gradio REST API ===
      // (Avoids @gradio/client overhead: no websocket handshake, no fallback
      // probe to WAV space, no client-side polling loops.)
      const separationStartTime = Date.now();
      setProgress('Preparing audio...');

      // Kick off audio download AND server warmup in parallel
      const warmupPromise = fetch(AAC_SPACE, { method: 'GET', cache: 'no-store' })
        .catch(() => null);
      const audioBlob = await getAudioBlob(audioUrl);
      await warmupPromise; // ensure Modal container is awake before upload

      const urlExt = audioUrl.split('?')[0].split('.').pop();
      const ext = (urlExt || 'm4a').toLowerCase();
      const safeExt = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext) ? ext : 'm4a';
      const mimeForExt: Record<string, string> = {
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
        flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
      };
      const fileName = `track.${safeExt}`;
      const audioFile = new File([audioBlob], fileName, { type: mimeForExt[safeExt] });

      console.log('[VocalSeparation] === UPLOAD INFO ===');
      console.log('[VocalSeparation] Audio:', Math.round(audioBlob.size / 1024), 'KB,', audioFile.type, 'ext:', safeExt);

      const base = AAC_SPACE.replace(/\/$/, '');

      // 1. Upload audio
      setProgress('Uploading audio...');
      const uploadStart = Date.now();
      const fd = new FormData();
      fd.append('files', audioFile, fileName);
      const uploadResp = await fetch(`${base}/gradio_api/upload`, { method: 'POST', body: fd });
      if (!uploadResp.ok) {
        throw new Error(`Audio upload failed: ${uploadResp.status} ${uploadResp.statusText}`);
      }
      const uploadJson = (await uploadResp.json()) as string[];
      const serverPath = uploadJson?.[0];
      if (!serverPath) throw new Error('Upload returned no path');
      console.log('[VocalSeparation] Uploaded in', Date.now() - uploadStart, 'ms ->', serverPath);

      // 2. Queue prediction via REST
      setProgress('AI vocal separation in progress...');
      const fileData = {
        path: serverPath,
        orig_name: fileName,
        mime_type: audioFile.type,
        meta: { _type: 'gradio.FileData' },
      };

      const predictStart = Date.now();
      const callResp = await fetch(`${base}/gradio_api/call/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [fileData] }),
      });
      if (!callResp.ok) throw new Error(`Predict call failed: ${callResp.status}`);
      const callJson = await callResp.json();
      const eventId = callJson?.event_id;
      if (!eventId) throw new Error('No event_id from predict call');
      console.log('[VocalSeparation] Predict queued, event_id:', eventId);

      // 3. Stream SSE result
      const PREDICT_TIMEOUT = 4 * 60 * 1000; // 4 minutes (server-side processing budget)
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

      const predictElapsed = Date.now() - predictStart;
      console.log('[VocalSeparation] Predict complete in', Math.round(predictElapsed / 1000), 's');

      if (!data) throw new Error('No data received from server');
      console.log('[VocalSeparation] Result:', JSON.stringify(data).slice(0, 500));

      const { instrumentalUrl: instUrl, vocalsUrl: vocUrl } = parseHFResult(data, true);
      const finalInstUrl = instUrl || (Array.isArray(data) ? (typeof data[0] === 'string' ? data[0] : data[0]?.url) : null);
      if (!finalInstUrl) throw new Error('No instrumental URL found');

      setProgress('Downloading separated tracks...');

      // Download tracks in parallel
      const [instrumentalBlob, vocalsBlob] = await Promise.all([
        downloadTrack(finalInstUrl, 'instrumental'),
        vocUrl ? downloadTrack(vocUrl, 'vocals').catch(e => {
          console.warn('[VocalSeparation] Vocals download failed:', e);
          return undefined;
        }) : Promise.resolve(undefined),
      ]);

      // Create object URLs for playback
      const instrumentalObjUrl = URL.createObjectURL(instrumentalBlob);
      const vocalsObjUrl = vocalsBlob ? URL.createObjectURL(vocalsBlob) : undefined;

      const totalElapsed = Date.now() - separationStartTime;
      console.log('[VocalSeparation] === SEPARATION COMPLETE ===');
      console.log('[VocalSeparation] Total time:', Math.round(totalElapsed / 1000), 'seconds');
      console.log('[VocalSeparation] Instrumental blob URL:', instrumentalObjUrl);
      console.log('[VocalSeparation] Vocals blob URL:', vocalsObjUrl || 'none');

      const separationResult: SeparationResult = {
        instrumentalUrl: instrumentalObjUrl,
        vocalsUrl: vocalsObjUrl,
        fromCache: false,
      };

      setSeparatedAudio(separationResult);
      setProgress('');
      setIsProcessing(false);

      // Cache in background
      saveCachedTracks(audioUrl, instrumentalBlob, vocalsBlob)
        .then(() => console.log('[VocalSeparation] Cached tracks saved'))
        .catch((err) => console.error('[VocalSeparation] Failed to cache:', err));

      return separationResult;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[VocalSeparation] Error:', message, err);
      setError(message);
      setProgress('');
      setIsProcessing(false);
      return null;
    } finally {
      abortControllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsProcessing(false);
    setProgress('');
    setError(null);
    setSeparatedAudio(null);
  }, []);

  return {
    isProcessing,
    progress,
    error,
    separatedAudio,
    separateVocals,
    reset,
  };
}
