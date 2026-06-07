/**
 * Unified audio permissions and iOS Safari audio session management.
 * This module centralizes all the complex iOS Safari workarounds for
 * microphone access and audio routing.
 */

// Audio session type for iOS Safari 17+
type AudioSessionType = 'auto' | 'playback' | 'play-and-record';

/**
 * Set the iOS audio session type (Safari 17+ only)
 * @param type - The audio session type to set
 */
export function setAudioSessionType(type: AudioSessionType): void {
  if ('audioSession' in navigator && (navigator as any).audioSession) {
    try {
      (navigator as any).audioSession.type = type;
      console.log(`[audio] Set audio session type to ${type}`);
    } catch (e) {
      console.log(`[audio] Could not set audio session type to ${type}:`, e);
    }
  }
}

/**
 * Get the AudioContext class with Safari fallback
 */
export function getAudioContextClass(): typeof AudioContext | null {
  return window.AudioContext || (window as any).webkitAudioContext || null;
}

/**
 * Create an AudioContext with optimal settings for karaoke
 * @returns A new AudioContext instance
 */
export async function createAudioContext(): Promise<AudioContext> {
  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) {
    throw new Error('AudioContext not supported on this browser');
  }

  const audioContext = new AudioContextClass({ latencyHint: 'playback' });
  
  // Resume AudioContext if suspended (required on iOS Safari)
  if (audioContext.state === 'suspended') {
    console.log('[audio] AudioContext suspended, resuming...');
    await audioContext.resume();
    console.log('[audio] AudioContext resumed:', audioContext.state);
  }

  return audioContext;
}

/**
 * Request microphone access with iOS Safari optimizations.
 * This handles the complex audio session dance required for iOS Safari 17+.
 * 
 * @returns The MediaStream from the microphone
 */
export async function requestMicrophone(): Promise<MediaStream> {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);

  // Step 1: Reset audio session to 'auto' BEFORE requesting microphone
  // This prevents iOS from getting stuck in a bad audio routing state
  setAudioSessionType('auto');

  // Step 2: Request microphone.
  // IMPORTANT:
  // - iOS Safari needs conservative, compatible constraints.
  // - Some Windows laptop mic/DSP paths (common on Lenovo) can yield near-silent WebAudio analyser
  //   magnitudes when AEC/NS/AGC are enabled. Legacy code usually used `audio: true` (raw).
  const stream = await navigator.mediaDevices.getUserMedia(
    isIOS
      ? {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }
      : {
          // Prefer raw capture for analysis reliability on desktop.
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        }
  );

  console.log('[audio] Microphone stream obtained, tracks:', stream.getAudioTracks().length);

  try {
    const t = stream.getAudioTracks()[0];
    console.log('[audio] Mic track settings:', t?.getSettings?.());
    console.log('[audio] Mic track constraints:', t?.getConstraints?.());
  } catch {
    // ignore
  }

  // Step 3: "Kick" audio session to 'play-and-record' AFTER getting the stream
  // This forces iOS to properly route audio for simultaneous playback and recording
  setAudioSessionType('play-and-record');

  return stream;
}

/**
 * Initialize microphone with AudioContext for audio analysis.
 * This is the main entry point for getting microphone access with proper iOS handling.
 * 
 * @returns Object containing the stream and audio context
 */
export async function initializeMicrophoneWithContext(): Promise<{
  stream: MediaStream;
  audioContext: AudioContext;
}> {
  const stream = await requestMicrophone();
  const audioContext = await createAudioContext();

  return { stream, audioContext };
}

/**
 * Format microphone error messages for user display
 * @param error - The error from getUserMedia or AudioContext
 * @returns A user-friendly error message
 */
export function formatMicrophoneError(error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  if (errorMessage.includes('not allowed') || 
      errorMessage.includes('Permission denied') || 
      errorMessage.includes('NotAllowedError')) {
    return 'Microphone blocked. Check Settings > Safari > Microphone';
  }
  
  if (errorMessage.includes('NotFoundError')) {
    return 'No microphone found on this device';
  }
  
  return 'Microphone access denied';
}

/**
 * Clean up audio resources
 * @param stream - The MediaStream to stop
 * @param audioContext - The AudioContext to close
 */
export function cleanupAudio(
  stream: MediaStream | null,
  audioContext: AudioContext | null
): void {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
  }
}
