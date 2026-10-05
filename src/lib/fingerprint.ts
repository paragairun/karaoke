/**
 * Fingerprint capture + identification, device-agnostic.
 *
 * WHY A DRIVER LAYER
 * The app is a static site (GitHub Pages) plus Capacitor wrappers, so it
 * cannot talk to a USB reader directly. Every scanner sold in India for
 * this job — Mantra MFS100, Startek FM220, Morpho/Idemia MSO — ships a
 * local service that exposes an HTTP endpoint on 127.0.0.1. Browsers
 * treat 127.0.0.1 as a potentially trustworthy origin, so an HTTPS page
 * may call it without a mixed-content error. The exact port, path and
 * payload differ per vendor, so each one is a driver behind this
 * interface and the rest of the app never knows which is attached.
 *
 * IMPORTANT CONSTRAINT, PLEASE READ
 * Those devices are usually sold in "RD Service" mode for Aadhaar. In
 * that mode the capture is returned as a UIDAI-encrypted PID block that
 * only UIDAI can decrypt — it CANNOT be used for local 1:N matching
 * against your own enrolled staff. Local matching needs the vendor's
 * non-RD SDK, which returns an ISO 19794-2 template. Confirm the device
 * is licensed for SDK/non-RD capture before buying in volume.
 *
 * Matching itself is delegated to the driver, because template matching
 * is proprietary to the vendor's algorithm. We never attempt to compare
 * templates in JavaScript — byte equality is not how fingerprint
 * matching works and would reject the same finger on every scan.
 */

export type FingerPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const FINGER_LABELS: Record<FingerPosition, string> = {
  1: "Right thumb",
  2: "Right index",
  3: "Right middle",
  4: "Right ring",
  5: "Right little",
  6: "Left thumb",
  7: "Left index",
  8: "Left middle",
  9: "Left ring",
  10: "Left little",
};

/** A single capture from the reader. */
export interface CaptureResult {
  /** base64 ISO/IEC 19794-2 template. Never a raw image. */
  template: string;
  templateFormat: string;
  /** 0-100. Below MIN_ENROLL_QUALITY we refuse to enrol. */
  quality: number;
  deviceModel?: string;
}

/** One enrolled finger, as handed to the matcher. */
export interface Candidate {
  enrollmentId: string;
  subjectId: string;
  subjectCategory: "society_staff" | "house_help";
  fingerPosition: number;
  template: string;
  name: string;
  role: string;
}

export interface MatchResult {
  candidate: Candidate;
  /** 0-100 as reported by the vendor matcher. */
  score: number;
}

export interface FingerprintDriver {
  readonly id: string;
  readonly label: string;
  /** Is the local service reachable and a reader plugged in? */
  isAvailable(): Promise<boolean>;
  /** Capture one impression. Rejects on timeout or no finger. */
  capture(opts?: { timeoutMs?: number }): Promise<CaptureResult>;
  /** 1:N identify against the supplied candidates. null = no match. */
  identify(probe: CaptureResult, candidates: Candidate[]): Promise<MatchResult | null>;
}

/** Enrolment is stricter than gate matching: a bad template haunts you. */
export const MIN_ENROLL_QUALITY = 60;
/** Score at or above which a gate match is accepted. */
export const MATCH_THRESHOLD = 40;

export class FingerprintError extends Error {
  constructor(message: string, readonly code:
    | "unavailable" | "timeout" | "no_finger" | "low_quality" | "driver_error") {
    super(message);
    this.name = "FingerprintError";
  }
}

/**
 * Driver for the common pattern: vendor service on 127.0.0.1 speaking
 * JSON over HTTP. Endpoint paths are configurable because they vary.
 */
export interface LocalBridgeConfig {
  id: string;
  label: string;
  baseUrl: string;          // e.g. http://127.0.0.1:11100
  capturePath: string;      // e.g. /capture
  identifyPath: string;     // e.g. /identify
  statusPath: string;       // e.g. /status
}

export class LocalBridgeDriver implements FingerprintDriver {
  constructor(private readonly cfg: LocalBridgeConfig) {}

  get id() { return this.cfg.id; }
  get label() { return this.cfg.label; }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.cfg.baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new FingerprintError(`Scanner service returned ${res.status}`, "driver_error");
      }
      return await res.json();
    } catch (err) {
      if (err instanceof FingerprintError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new FingerprintError("Scanner timed out. Try again.", "timeout");
      }
      throw new FingerprintError(
        "Could not reach the scanner service. Is it running?", "unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(this.cfg.baseUrl + this.cfg.statusPath, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async capture(opts?: { timeoutMs?: number }): Promise<CaptureResult> {
    const data = await this.post(this.cfg.capturePath, { timeout: 10 }, opts?.timeoutMs ?? 15000);
    if (!data?.template) {
      throw new FingerprintError("No finger detected on the scanner.", "no_finger");
    }
    return {
      template: String(data.template),
      templateFormat: String(data.format ?? "ISO-19794-2"),
      quality: Number(data.quality ?? 0),
      deviceModel: data.device ? String(data.device) : undefined,
    };
  }

  async identify(probe: CaptureResult, candidates: Candidate[]): Promise<MatchResult | null> {
    if (!candidates.length) return null;
    const data = await this.post(this.cfg.identifyPath, {
      probe: probe.template,
      threshold: MATCH_THRESHOLD,
      gallery: candidates.map((c) => ({ id: c.enrollmentId, template: c.template })),
    }, 20000);

    if (!data?.matchId) return null;
    const candidate = candidates.find((c) => c.enrollmentId === data.matchId);
    if (!candidate) return null;
    const score = Number(data.score ?? 0);
    return score >= MATCH_THRESHOLD ? { candidate, score } : null;
  }
}

/**
 * Mock driver — used by tests and by `?fpmock=1`, so the whole enrolment
 * and gate flow can be exercised with no hardware present. It matches on
 * exact template equality, which is meaningless for real fingerprints but
 * perfectly deterministic for testing the surrounding logic.
 */
export class MockFingerprintDriver implements FingerprintDriver {
  readonly id = "mock";
  readonly label = "Mock scanner (testing)";
  private next: CaptureResult | null = null;

  constructor(private readonly available = true) {}

  /** Queue the capture the next call will return. */
  setNextCapture(c: CaptureResult) { this.next = c; }

  async isAvailable() { return this.available; }

  async capture(): Promise<CaptureResult> {
    if (!this.available) {
      throw new FingerprintError("No scanner attached.", "unavailable");
    }
    if (!this.next) {
      throw new FingerprintError("No finger detected on the scanner.", "no_finger");
    }
    const c = this.next;
    this.next = null;
    return c;
  }

  async identify(probe: CaptureResult, candidates: Candidate[]): Promise<MatchResult | null> {
    const hit = candidates.find((c) => c.template === probe.template);
    return hit ? { candidate: hit, score: 99 } : null;
  }
}

/** Known local-bridge presets. Ports are the vendors' documented defaults. */
export const BRIDGE_PRESETS: Record<string, LocalBridgeConfig> = {
  mantra: {
    id: "mantra",
    label: "Mantra MFS100",
    baseUrl: "http://127.0.0.1:11100",
    capturePath: "/capture",
    identifyPath: "/identify",
    statusPath: "/status",
  },
  startek: {
    id: "startek",
    label: "Startek FM220",
    baseUrl: "http://127.0.0.1:11101",
    capturePath: "/capture",
    identifyPath: "/identify",
    statusPath: "/status",
  },
  generic: {
    id: "generic",
    label: "Generic local bridge",
    baseUrl: "http://127.0.0.1:8080",
    capturePath: "/capture",
    identifyPath: "/identify",
    statusPath: "/status",
  },
};

let activeDriver: FingerprintDriver | null = null;

/** Swap the driver (tests, or a society configuring its hardware). */
export function setFingerprintDriver(driver: FingerprintDriver | null) {
  activeDriver = driver;
}

export function getFingerprintDriver(): FingerprintDriver {
  if (activeDriver) return activeDriver;
  if (typeof window !== "undefined" && window.location.search.includes("fpmock=1")) {
    activeDriver = new MockFingerprintDriver();
    return activeDriver;
  }
  const saved = typeof localStorage !== "undefined"
    ? localStorage.getItem("fp_driver") : null;
  const preset = (saved && BRIDGE_PRESETS[saved]) || BRIDGE_PRESETS.mantra;
  activeDriver = new LocalBridgeDriver(preset);
  return activeDriver;
}

/** Persist the society's chosen reader for this device. */
export function rememberDriverChoice(presetId: string) {
  if (typeof localStorage !== "undefined") localStorage.setItem("fp_driver", presetId);
  activeDriver = BRIDGE_PRESETS[presetId]
    ? new LocalBridgeDriver(BRIDGE_PRESETS[presetId]) : null;
}

/** Guard rail used by the enrolment UI. */
export function assertEnrollable(capture: CaptureResult): void {
  if (capture.quality < MIN_ENROLL_QUALITY) {
    throw new FingerprintError(
      `Scan quality ${capture.quality}% is too low to enrol (need ${MIN_ENROLL_QUALITY}%). ` +
      `Clean the sensor, dry the finger and try again.`,
      "low_quality",
    );
  }
}
