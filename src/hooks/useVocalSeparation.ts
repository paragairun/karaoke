import { useState, useCallback, useRef } from 'react';
import { Client, handle_file } from '@gradio/client';
import { supabase } from '@/integrations/supabase/client';
import { getCachedTracks, saveCachedTracks, clearOldCache } from '@/lib/audioCache';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

// Audio prefetch cache - stores downloaded blobs before separation starts
const audioPrefetchCache = new Map<string, { blob: Blob; timestamp: number }>();
const PREFETCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Track if HF space has been warmed up this session
let hfSpaceWarmedUp = false;
let hfWarmUpPromise: Promise<void> | null = null;

// Vocal separation endpoints (Gradio-compatible)
const AAC_SPACE = "https://ajparag--vocal-separator-v3-ui.modal.run/";
const WAV_SPACE_PRIMARY = "abidlabs/music-separation";

// Warm up HuggingFace space proactively (non-blocking, singleton)
export async function warmUpHFSpace(): Promise<void> {
  if (hfSpaceWarmedUp) return Promise.resolve();
  if (hfWarmUpPromise) return hfWarmUpPromise;

  hfWarmUpPromise = (async () => {
    try {
      console.log('[VocalSeparation] Warming up HF space...');
      const { data } = await supabase.functions.invoke('separate-vocals', {
        body: { warmUp: true },
      });
      if (data?.ready) {
        hfSpaceWarmedUp = true;
        console.log('[VocalSeparation] HF space is warm!');
      }
    } catch (err) {
      console.warn('[VocalSeparation] HF warm-up failed (non-critical):', err);
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

      // === CLIENT-SIDE SEPARATION via @gradio/client ===
      const separationStartTime = Date.now();
      setProgress('Preparing audio...');
      const audioBlob = await getAudioBlob(audioUrl);
      console.log('[VocalSeparation] === UPLOAD INFO ===');
      console.log('[VocalSeparation] Audio blob size:', Math.round(audioBlob.size / 1024), 'KB', `(${audioBlob.size} bytes)`);
      console.log('[VocalSeparation] Audio blob type:', audioBlob.type || 'unknown');
      console.log('[VocalSeparation] Audio URL:', audioUrl.slice(0, 100));
      const urlExt = audioUrl.split('?')[0].split('.').pop();
      console.log('[VocalSeparation] URL extension:', urlExt);

      setProgress('Connecting to AI model...');
      const connectStart = Date.now();
      const { client, spaceId, isAac } = await connectToHFSpace();
      console.log('[VocalSeparation] Connected to', spaceId, 'in', Date.now() - connectStart, 'ms (aac:', isAac, ')');

      setProgress('AI vocal separation (this may take 3-5 min)...');

      // Wrap blob in a named File so Gradio detects audio MIME/extension
      const ext = (urlExt || 'm4a').toLowerCase();
      const safeExt = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext) ? ext : 'm4a';
      const mimeType = audioBlob.type && audioBlob.type !== 'audio/mp4'
        ? audioBlob.type
        : 'audio/mp4';
      const audioFile = new File([audioBlob], `track.${safeExt}`, { type: mimeType });
      const wrappedAudio = handle_file(audioFile);
      const predictArgs = isAac ? [wrappedAudio] : { audio: wrappedAudio };

      console.log('[VocalSeparation] Starting predict on', spaceId, 'at', new Date().toISOString());
      const predictStart = Date.now();
      
      // Add timeout race
      const PREDICT_TIMEOUT = 6 * 60 * 1000; // 6 minutes
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Predict timed out after ${PREDICT_TIMEOUT / 1000}s`)), PREDICT_TIMEOUT)
      );
      
      const result = await Promise.race([
        client.predict("/predict", predictArgs),
        timeoutPromise,
      ]) as any;
      
      const predictElapsed = Date.now() - predictStart;
      console.log('[VocalSeparation] Predict complete in', Math.round(predictElapsed / 1000), 'seconds');

      const data = result.data as any;
      console.log('[VocalSeparation] === RESULT INFO ===');
      console.log('[VocalSeparation] Result data type:', typeof data, Array.isArray(data) ? `(array of ${data.length})` : '');
      console.log('[VocalSeparation] Result data:', JSON.stringify(data, null, 2).slice(0, 1000));

      const { instrumentalUrl: instUrl, vocalsUrl: vocUrl } = parseHFResult(data, isAac);

      if (!instUrl) {
        // Last resort: use first URL
        const firstUrl = Array.isArray(data) && data.length > 0
          ? (typeof data[0] === 'string' ? data[0] : data[0]?.url)
          : null;
        if (!firstUrl) {
          throw new Error('Could not find instrumental track in result');
        }
        console.warn('[VocalSeparation] Using first URL as instrumental fallback');
      }

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
