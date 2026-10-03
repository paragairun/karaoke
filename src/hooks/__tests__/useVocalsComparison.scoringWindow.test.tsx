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

async function setup(initialScoring: boolean | undefined, isPlaying = true) {
  let latest: any;
  function Harness(props: { scoringEnabled?: boolean; isPlaying: boolean }) {
    latest = useVocalsComparison({ vocalsUrl: 'blob:mock-vocals', isPlaying: props.isPlaying, currentTime: 0, scoringEnabled: props.scoringEnabled });
    return null;
  }
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => { root.render(<Harness scoringEnabled={initialScoring} isPlaying={isPlaying} />); });
  await act(async () => { await latest.startAnalysis(); });
  const step = async (n: number) => { for (let i = 0; i < n; i++) await act(async () => { rafCb?.(); }); };
  const setProps = async (scoringEnabled: boolean | undefined, playing = isPlaying) => {
    await act(async () => { root.render(<Harness scoringEnabled={scoringEnabled} isPlaying={playing} />); });
  };
  // Exact session values (metrics state is throttled to ~15x/s).
  return { get: () => latest, snap: () => latest.getSessionSnapshot(), step, setProps };
}

describe('useVocalsComparison scoring window', () => {
  it('scores NOTHING while scoringEnabled=false, even with loud in-tune input', async () => {
    const h = await setup(false);
    await h.step(120);
    const m = h.get().metrics;
    expect(m.referenceActive).toBe(true);   // detection still runs
    expect(m.isVoiceDetected).toBe(true);
    expect(m.scoringNow).toBe(false);
    const s = h.snap();
    expect(s.refActiveFrames).toBe(0);
    expect(s.voicedFrames).toBe(0);
    expect(s.scoredFrames).toBe(0);
    expect(s.accuracy).toBeNull();
    expect(s.total).toBe(0);
  });

  it('starts scoring once the window opens (lyrics start)', async () => {
    const h = await setup(false);
    await h.step(120);
    await h.setProps(true);
    await h.step(120);
    const s = h.snap();
    expect(s.refActiveFrames).toBe(120);    // exactly the frames after opening
    expect(s.voicedFrames).toBe(120);
    expect(s.scoredFrames).toBe(120);
    expect(s.accuracy).toBeGreaterThan(95); // mic and reference are the same 220 Hz tone
    expect(s.total).toBeGreaterThan(0);
  });

  it('pauses scoring when the window closes, without resetting', async () => {
    const h = await setup(true);
    await h.step(60);
    const before = h.snap().refActiveFrames;
    await h.setProps(false);
    await h.step(60);
    expect(h.snap().refActiveFrames).toBe(before);
  });

  it('scores nothing while the song is paused (isPlaying=false)', async () => {
    const h = await setup(true, false);
    await h.step(60);
    expect(h.snap().refActiveFrames).toBe(0);
  });

  it('undefined scoringEnabled keeps the window open', async () => {
    const h = await setup(undefined);
    await h.step(60);
    // startAnalysis() runs one frame itself before the rAF loop -> 1 + 60
    expect(h.snap().refActiveFrames).toBe(61);
  });

  it('resetAccumulators clears the session', async () => {
    const h = await setup(true);
    await h.step(30);
    await act(async () => { h.get().resetAccumulators(); });
    expect(h.snap().refActiveFrames).toBe(0);
    expect(h.get().metrics.totalScore).toBe(0);
  });
});
