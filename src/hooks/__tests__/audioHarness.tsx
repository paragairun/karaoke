// Test utility (not a test): runs the REAL useVocalsComparison analysis loop
// with mocked Web Audio. The mic and the reference vocals get separate,
// time-varying signals; the clock advances 1/60 s per frame; every hidden
// Audio element the hook creates is tracked so tests can check whether the
// reference is playing (= audible if not captured).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { vi } from 'vitest';

export const SR = 48000;
type Signal = (arr: Float32Array, tMs: number) => void;

export const fillSine = (arr: Float32Array, hz: number, amp: number) => {
  for (let i = 0; i < arr.length; i++) arr[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
};
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
export const silence: Signal = arr => arr.fill(0);
export const noise = (rms: number): Signal => arr => { for (let i = 0; i < arr.length; i++) arr[i] = rnd() * rms * 1.732; };
export const tone = (hz: number, rms: number): Signal => arr => fillSine(arr, hz, rms * 1.414);
export const plus = (a: Signal, b: Signal): Signal => (arr, t) => {
  const tmp = new Float32Array(arr.length); a(arr, t); b(tmp, t);
  for (let i = 0; i < arr.length; i++) arr[i] += tmp[i];
};

export const state = {
  clock: 0,
  mic: silence as Signal,
  ref: tone(220, 0.21) as Signal,
  rafCb: null as null | (() => void),
  audios: [] as FakeAudio[],
};

function makeAnalyser(kind: 'mic' | 'ref') {
  const a: any = {
    fftSize: 2048, smoothingTimeConstant: 0, minDecibels: -100, maxDecibels: -30,
    get frequencyBinCount() { return a.fftSize / 2; },
    getFloatTimeDomainData: (arr: Float32Array) => (kind === 'mic' ? state.mic : state.ref)(arr, state.clock),
    getFloatFrequencyData: (arr: Float32Array) => arr.fill(-100),
    getByteFrequencyData: (arr: Uint8Array) => arr.fill(0),
    connect: vi.fn(), disconnect: vi.fn(),
  };
  return a;
}
const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: { value: 1 } });
export function makeCtx(kind: 'mic' | 'ref'): any {
  return {
    state: 'running', sampleRate: SR, destination: {},
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createAnalyser: () => makeAnalyser(kind), createGain: node, createOscillator: node,
    createMediaStreamSource: node, createMediaElementSource: node,
  };
}
const fakeStream: any = { getAudioTracks: () => [{ label: 'mock-mic', stop: vi.fn() }], getTracks: () => [{ stop: vi.fn() }] };
export const audioPermissionsMock = {
  cleanupAudio: vi.fn(),
  createAudioContext: vi.fn(async () => makeCtx('mic')),
  formatMicrophoneError: (e: unknown) => String(e),
  requestMicrophone: vi.fn(async () => fakeStream),
};

export class FakeAudio {
  readyState = 4; currentTime = 0; paused = true; crossOrigin = ''; src = ''; preload = '';
  oncanplay: any; onloadeddata: any; onerror: any;
  constructor() { state.audios.push(this); }
  load() {} pause() { this.paused = true; } play() { this.paused = false; return Promise.resolve(); }
  addEventListener() {} removeEventListener() {}
}

export function installAudioMocks() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).Audio = FakeAudio;
  (window as any).AudioContext = function () { return makeCtx('ref'); };
  (window as any).requestAnimationFrame = (cb: () => void) => { state.rafCb = cb; return 1; };
  (window as any).cancelAnimationFrame = () => { state.rafCb = null; };
  state.clock = 0; state.mic = silence; state.ref = tone(220, 0.21); state.rafCb = null; state.audios = [];
  vi.spyOn(performance, 'now').mockImplementation(() => state.clock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

type HookFn = (o: any) => any;
export async function setupHook(useHook: HookFn, opts: { scoringEnabled?: boolean; isPlaying?: boolean; start?: boolean } = {}) {
  let latest: any;
  let props = { scoringEnabled: opts.scoringEnabled, isPlaying: opts.isPlaying ?? true };
  function Harness(p: typeof props) {
    latest = useHook({ vocalsUrl: 'blob:mock-vocals', isPlaying: p.isPlaying, currentTime: 0, scoringEnabled: p.scoringEnabled });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness {...props} />); });
  const api = {
    get: () => latest,
    snap: () => latest.getSessionSnapshot(),
    start: async () => { await act(async () => { await latest.startAnalysis(); }); },
    /** Advance `seconds` of frames at 60 fps; `mic` optionally changes the mic signal first. */
    run: async (seconds: number, mic?: Signal) => {
      if (mic) state.mic = mic;
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) { state.clock += 1000 / 60; await act(async () => { state.rafCb?.(); }); }
    },
    set: async (p: Partial<typeof props>) => {
      props = { ...props, ...p };
      await act(async () => { root.render(<Harness {...props} />); });
    },
  };
  if (opts.start !== false) await api.start();
  return api;
}
