// @vitest-environment jsdom
// Hook-level test: runs the REAL useVocalsComparison analysis loop with mocked
// audio inputs (loud, pitched signal on both mic and reference for every
// frame -- the worst case for an intro where bleed + speaker pickup trip both
// detectors). Verifies that while scoringEnabled=false nothing accumulates in
// the background, and that scoring starts once it flips true.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const SR = 48000;
function fillSine(arr: Float32Array, freq: number, amp: number) {
  for (let i = 0; i < arr.length; i++) arr[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
}
function makeAnalyser() {
  const a: any = {
    fftSize: 2048, smoothingTimeConstant: 0, minDecibels: -100, maxDecibels: -30,
    get frequencyBinCount() { return a.fftSize / 2; },
    getFloatTimeDomainData: (arr: Float32Array) => fillSine(arr, 220, 0.3),
    getByteFrequencyData: (arr: Uint8Array) => arr.fill(0),
    getFloatFrequencyData: (arr: Float32Array) => arr.fill(-100),
    connect: vi.fn(), disconnect: vi.fn(),
  };
  return a;
}
function makeNode() { return { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: { value: 1 } }; }
function makeCtx(): any {
  return {
    state: 'running', sampleRate: SR, destination: {},
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createAnalyser: makeAnalyser, createGain: makeNode, createOscillator: makeNode,
    createMediaStreamSource: makeNode, createMediaElementSource: makeNode,
  };
}
const fakeStream: any = { getAudioTracks: () => [{ label: 'mock-mic', stop: vi.fn() }], getTracks: () => [{ stop: vi.fn() }] };

vi.mock('@/lib/audioPermissions', () => ({
  cleanupAudio: vi.fn(),
  createAudioContext: vi.fn(async () => makeCtx()),
  formatMicrophoneError: (e: unknown) => String(e),
  requestMicrophone: vi.fn(async () => fakeStream),
}));

class FakeAudio {
  readyState = 4; currentTime = 0; paused = true; crossOrigin = ''; src = ''; preload = '';
  oncanplay: any; onloadeddata: any; onerror: any;
  load() {} pause() { this.paused = true; } play() { this.paused = false; return Promise.resolve(); }
  addEventListener() {} removeEventListener() {}
}

let rafCb: (() => void) | null = null;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).Audio = FakeAudio;
  (window as any).AudioContext = function () { return makeCtx(); };
  (window as any).requestAnimationFrame = (cb: () => void) => { rafCb = cb; return 1; };
  (window as any).cancelAnimationFrame = () => { rafCb = null; };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

import { useVocalsComparison } from '@/hooks/useVocalsComparison';

async function setup(initialScoring: boolean | undefined) {
  let latest: any;
  function Harness(props: { scoringEnabled?: boolean }) {
    latest = useVocalsComparison({ vocalsUrl: 'blob:mock-vocals', isPlaying: true, currentTime: 0, scoringEnabled: props.scoringEnabled });
    return null;
  }
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => { root.render(<Harness scoringEnabled={initialScoring} />); });
  await act(async () => { await latest.startAnalysis(); });
  const step = async (n: number) => { for (let i = 0; i < n; i++) await act(async () => { rafCb?.(); }); };
  const setScoring = async (v: boolean | undefined) => { await act(async () => { root.render(<Harness scoringEnabled={v} />); }); };
  return { get: () => latest, step, setScoring };
}

describe('useVocalsComparison scoring window', () => {
  it('accumulates NOTHING while scoringEnabled=false, even with loud voiced input', async () => {
    const h = await setup(false);
    await h.step(120); // ~2s of intro frames
    const m = h.get().metrics;
    expect(m.referenceActive).toBe(true);   // detection still runs
    expect(m.isVoiceDetected).toBe(true);
    expect(m.voicedFrames).toBe(0);         // background counters untouched
    expect(m.refActiveFrames).toBe(0);
    expect(m.pitchMatch).toBe(0);
    expect(m.rhythmMatch).toBe(0);
    expect(m.techniqueMatch).toBe(0);
  });

  it('starts scoring once the window opens (lyrics start)', async () => {
    const h = await setup(false);
    await h.step(120);
    await h.setScoring(true);
    await h.step(120);
    const m = h.get().metrics;
    expect(m.refActiveFrames).toBe(120);    // exactly the frames after opening
    expect(m.voicedFrames).toBe(120);
    expect(m.pitchMatch + m.rhythmMatch + m.techniqueMatch).toBeGreaterThan(0);
  });

  it('pauses accumulation again when the window closes, without resetting', async () => {
    const h = await setup(true);
    await h.step(60);
    const before = h.get().metrics.refActiveFrames;
    await h.setScoring(false);
    await h.step(60);
    expect(h.get().metrics.refActiveFrames).toBe(before);
  });

  it('undefined scoringEnabled keeps previous always-on behaviour', async () => {
    const h = await setup(undefined);
    await h.step(60);
    // startAnalysis() runs one frame itself before the rAF loop -> 1 + 60
    expect(h.get().metrics.refActiveFrames).toBe(61);
  });
});
