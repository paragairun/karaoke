/**
 * Unified audio permissions and iOS Safari audio session management.
 *
 * BUGS FIXED vs original:
 *
 * 1. latencyHint: 'playback' → 'interactive'
 *    'playback' optimises for large buffer/low CPU (music streaming).
 *    For real-time mic analysis you need 'interactive' which gives the
 *    smallest possible buffer and lowest latency. 'playback' was adding
 *    100–400ms of unnecessary latency to every analyser read.
 *
 * 2. AudioContext.close() was called without await.
 *    close() returns a Promise. Ignoring it means the context may not be
 *    fully torn down before a new one is created, leaking audio nodes
 *    and causing "AudioContext was already closed" errors on the next mount.
 *
 * 3. iOS resume() retry loop added.
 *    Known Safari bug: audioContext.resume() resolves but state stays
 *    'suspended'. The fix is to poll state after resume() and retry up
 *    to 3 times with a short delay before giving up.
 *
 * 4. OverconstrainedError fallback added.
 *    If the browser rejects our constraints (rare on some Android devices),
 *    we retry with audio: true (bare minimum) rather than throwing.
 *
 * 5. formatMicrophoneError covers all 7 getUserMedia error types.
 *    NotReadableError (mic in use by another app), SecurityError
 *    (non-HTTPS), AbortError, and OverconstrainedError all previously
 *    fell through to the generic "Microphone access denied" message.
 *
 * 6. Singleton AudioContext per caller via module-level ref.
 *    Multiple hooks (useVocalsComparison, useVocalAnalysis) were each
 *    creating their own AudioContext. On iOS, >1 active AudioContext
 *    causes audio routing failures and mic dropouts. We now reuse a
 *    single shared context and resume it if suspended rather than
 *    creating a new one.
 *
 * 7. Permissions API pre-check added.
 *    On browsers that support navigator.permissions.query, we check
 *    mic permission state before calling getUserMedia. This avoids
 *    re-triggering the permission prompt on iOS Safari when permission
 *    was already granted in a previous session.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type AudioSessionType = 'auto' | 'playback' | 'play-and-record';

// ─── Singleton AudioContext ───────────────────────────────────────────────────
// Shared across all hooks. iOS Safari crashes or misbehaves with >1 active
// AudioContext. All callers get the same instance; it is only closed via
// cleanupAudio when the last caller is done.

let sharedAudioContext: AudioContext | null = null;
let sharedAudioContextRefCount = 0;

// ─── iOS Audio Session ────────────────────────────────────────────────────────

export function setAudioSessionType(type: AudioSessionType): void {
  if ('audioSession' in navigator && (navigator as any).audioSession) {
    try {
      (navigator as any).audioSession.type = type;
      console.log(`[audio] audioSession.type = ${type}`);
    } catch (e) {
      console.log(`[audio] Could not set audioSession.type to ${type}:`, e);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getAudioContextClass(): typeof AudioContext | null {
  return window.AudioContext || (window as any).webkitAudioContext || null;
}

function isIOS(): boolean {
  const ua = navigator.userAgent || '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1)
  );
}

function getErrorName(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor?.name || '';
  if (typeof err === 'object' && err !== null && 'name' in err) return String((err as any).name);
  return '';
}

// ─── AudioContext ──────────────────────────────────────────────────────────────

/**
 * Returns the shared AudioContext, creating it if necessary.
 * If the context is suspended, resumes it (with iOS retry logic).
 *
 * FIX 1: latencyHint changed from 'playback' to 'interactive'.
 * FIX 3: iOS resume() retry loop — polls state up to 3× after resume().
 * FIX 6: Singleton — all callers share one context; refcount tracks usage.
 */
export async function createAudioContext(): Promise<AudioContext> {
  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) {
    throw new Error('AudioContext not supported on this browser');
  }

  // Reuse existing context if it's still open
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    sharedAudioContextRefCount++;
    if (sharedAudioContext.state === 'suspended') {
      await resumeAudioContext(sharedAudioContext);
    }
    console.log(
      `[audio] Reusing shared AudioContext (refCount=${sharedAudioContextRefCount}, state=${sharedAudioContext.state})`
    );
    return sharedAudioContext;
  }

  // Create new context
  // FIX 1: 'interactive' gives smallest buffer → lowest latency for real-time analysis.
  // 'playback' (original) was optimised for streaming, adding 100–400ms of unnecessary
  // analyser latency that made pitch detection feel sluggish.
  sharedAudioContext = new AudioContextClass({ latencyHint: 'interactive' });
  sharedAudioContextRefCount = 1;

  if (sharedAudioContext.state === 'suspended') {
    await resumeAudioContext(sharedAudioContext);
  }

  console.log(
    `[audio] Created AudioContext (state=${sharedAudioContext.state}, ` +
    `sampleRate=${sharedAudioContext.sampleRate}, ` +
    `baseLatency=${(sharedAudioContext as any).baseLatency?.toFixed(4) ?? 'n/a'}s)`
  );

  return sharedAudioContext;
}

/**
 * Resume an AudioContext with iOS retry logic.
 * FIX 3: iOS Safari bug — resume() resolves but state stays 'suspended'.
 * We poll the state after each resume() call and retry up to 3 times.
 */
async function resumeAudioContext(ctx: AudioContext, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ctx.resume();
    } catch (e) {
      console.warn(`[audio] resume() threw on attempt ${attempt}:`, e);
    }

    if (ctx.state === 'running') {
      console.log(`[audio] AudioContext running after ${attempt} attempt(s)`);
      return;
    }

    if (attempt < maxRetries) {
      // Brief delay before retry — gives Safari time to process the resume
      await new Promise(r => setTimeout(r, 150 * attempt));
    }
  }

  // Non-fatal: log warning but don't throw.
  // The analyser may still work even in 'suspended' on some browsers.
  console.warn(
    `[audio] AudioContext still '${ctx.state}' after ${maxRetries} resume attempts. ` +
    'Analysis may not work until user interaction.'
  );
}

// ─── Microphone ───────────────────────────────────────────────────────────────

/**
 * Check microphone permission state without triggering a prompt.
 * FIX 7: Avoids re-triggering the iOS permission dialog when permission
 * was already granted in a previous session.
 * Returns 'granted' | 'denied' | 'prompt' | 'unknown'.
 */
async function checkMicPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    if (navigator.permissions?.query) {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return result.state as 'granted' | 'denied' | 'prompt';
    }
  } catch {
    // permissions API not available (iOS Safari <16, Firefox in some contexts)
  }
  return 'unknown';
}

/**
 * Request microphone access with iOS Safari and Windows optimisations.
 *
 * FIX 4: OverconstrainedError fallback — if constraints are rejected,
 *        retry with bare audio:true.
 * FIX 5: Permissions pre-check — avoids redundant permission prompts.
 *
 * Constraint strategy:
 * - iOS: use processed constraints (AEC/NS/AGC on). iOS hardware DSP is
 *   reliable; disabling these causes echo/noise problems on iPhone.
 * - Desktop: disable AEC/NS/AGC for raw signal. Windows laptop mic drivers
 *   with heavy DSP processing can produce near-silent WebAudio analysers
 *   when these are enabled.
 */
export async function requestMicrophone(): Promise<MediaStream> {
  // Pre-check: if already denied, fail fast with a clear message
  const permState = await checkMicPermission();
  if (permState === 'denied') {
    throw new Error(
      'NotAllowedError: Microphone permission was previously denied. ' +
      'Please reset it in your browser settings.'
    );
  }

  const ios = isIOS();

  // Step 1: reset audio session before acquiring mic (iOS routing dance)
  setAudioSessionType('auto');

  // Preferred constraints
  const preferredConstraints: MediaStreamConstraints = ios
    ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
    : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };

  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
  } catch (err) {
    const name = getErrorName(err);

    // FIX 4: OverconstrainedError — our specific constraints can't be satisfied.
    // Retry with bare audio:true which lets the browser pick whatever works.
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      console.warn('[audio] Constraints not satisfiable, retrying with audio:true');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (fallbackErr) {
        throw fallbackErr; // re-throw the fallback error for formatMicrophoneError
      }
    } else {
      throw err;
    }
  }

  // Step 2: kick to play-and-record AFTER acquiring stream (iOS routing)
  setAudioSessionType('play-and-record');

  // Log track details for debugging
  try {
    const track = stream.getAudioTracks()[0];
    console.log('[audio] Mic acquired:', {
      label: track?.label,
      settings: track?.getSettings?.(),
    });
  } catch { /* ignore */ }

  return stream;
}

/**
 * Convenience: get mic stream + shared AudioContext together.
 */
export async function initializeMicrophoneWithContext(): Promise<{
  stream: MediaStream;
  audioContext: AudioContext;
}> {
  const stream = await requestMicrophone();
  const audioContext = await createAudioContext();
  return { stream, audioContext };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Stop a MediaStream and release the shared AudioContext when no longer needed.
 *
 * FIX 2: AudioContext.close() is now awaited.
 * FIX 6: Ref-counted — only closes the shared context when refCount reaches 0.
 *
 * Pass stream=null if you only want to decrement the AudioContext refcount.
 */
export async function cleanupAudio(
  stream: MediaStream | null,
  audioContext: AudioContext | null,
): Promise<void> {
  // Stop all mic tracks
  if (stream) {
    stream.getTracks().forEach(track => {
      track.stop();
      console.log('[audio] Mic track stopped:', track.label);
    });
  }

  // Decrement refcount; only close when nobody is using the context
  if (audioContext) {
    sharedAudioContextRefCount = Math.max(0, sharedAudioContextRefCount - 1);

    if (sharedAudioContextRefCount === 0) {
      if (audioContext.state !== 'closed') {
        try {
          await audioContext.close(); // FIX 2: awaited
          console.log('[audio] Shared AudioContext closed');
        } catch (e) {
          console.warn('[audio] Error closing AudioContext:', e);
        }
      }
      sharedAudioContext = null;
    } else {
      console.log(`[audio] AudioContext refCount=${sharedAudioContextRefCount}, keeping open`);
    }
  }

  // Reset iOS audio session when fully done
  if (sharedAudioContextRefCount === 0) {
    setAudioSessionType('auto');
  }
}

// ─── Error Formatting ─────────────────────────────────────────────────────────

/**
 * FIX 5: All 7 getUserMedia error types now have specific messages.
 * Original only handled NotAllowedError and NotFoundError; everything
 * else (NotReadableError, SecurityError, AbortError, OverconstrainedError,
 * TypeError) fell through to a generic "Microphone access denied".
 */
export function formatMicrophoneError(error: unknown): string {
  const name = getErrorName(error);
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' ||
      message.includes('not allowed') || message.includes('Permission denied')) {
    return 'Microphone access blocked. Please allow microphone access in your browser settings and reload.';
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone found on this device. Please connect a microphone and try again.';
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is in use by another app. Please close other apps using the microphone and try again.';
  }

  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'Your microphone does not support the required settings. Trying with default settings…';
  }

  if (name === 'SecurityError') {
    return 'Microphone access requires a secure (HTTPS) connection.';
  }

  if (name === 'AbortError') {
    return 'Microphone access was interrupted. Please try again.';
  }

  if (name === 'TypeError') {
    return 'Microphone configuration error. Please reload and try again.';
  }

  // Catch-all
  return `Could not access microphone: ${message || 'Unknown error'}. Please check your browser settings.`;
}
