// @vitest-environment jsdom
// Regression tests for "scores move while the user isn't singing".
// Real useVocalsComparison loop, mocked Web Audio (see audioHarness.tsx).
// Realistic timeline: the mic starts when the song starts (intro, scoring
// window closed), then the lyrics start and the window opens.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installAudioMocks, setupHook, state, noise, tone, plus, SR } from './audioHarness';

vi.mock('@/lib/audioPermissions', async () => (await import('./audioHarness')).audioPermissionsMock);
import { useVocalsComparison } from '@/hooks/useVocalsComparison';

beforeEach(() => installAudioMocks());

// Short noisy bursts (key presses), aperiodic.
const typing = (arr: Float32Array, t: number) => {
  let s = (Math.floor(t) * 9301 + 49297) % 233280;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280) * 2 - 1;
  const inBurst = Math.floor(t / 150) % 2 === 0;
  for (let i = 0; i < arr.length; i++) arr[i] = inBurst && i < SR * 0.01 ? r() * 0.5 : r() * 0.002;
};

const ROOMS = {
  'quiet room': noise(0.005),
  'auto-gain boosted room noise': noise(0.05),
  'electrical hum 120 Hz': plus(tone(120, 0.05), noise(0.005)),
  'fan (hum + broadband noise)': plus(tone(100, 0.03), noise(0.04)),
  'typing / clicks': typing,
} as const;

describe('silent singer scores nothing', () => {
  for (const [room, sig] of Object.entries(ROOMS)) {
    it(room, async () => {
      const h = await setupHook(useVocalsComparison, { scoringEnabled: false });
      await h.run(10, sig);            // intro: mic on, lyrics not started
      await h.set({ scoringEnabled: true });
      await h.run(20);                 // lyrics running, user silent, original vocals active
      const s = h.snap();
      expect(s.refActiveFrames).toBeGreaterThan(1000); // the singer was singing...
      expect(s.scoredFrames).toBe(0);                  // ...but nothing of yours was scored
      expect(s.total).toBe(0);
    });
  }
});

describe('real singing still scores', () => {
  it('phrases with breaths over a humming room', async () => {
    const room = plus(tone(120, 0.05), noise(0.005));
    const h = await setupHook(useVocalsComparison, { scoringEnabled: false });
    await h.run(10, room);
    await h.set({ scoringEnabled: true });
    for (let p = 0; p < 4; p++) {
      await h.run(3, plus(tone(220, 0.3), room)); // sing in tune with the reference
      await h.run(0.5, room);                     // breath
    }
    const s = h.snap();
    expect(s.scoredFrames).toBeGreaterThan(0.9 * 4 * 180);
    expect(s.accuracy!).toBeGreaterThan(95);
  });

  it('a long 8 s held note stays detected', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: false });
    await h.run(10, noise(0.005));
    await h.set({ scoringEnabled: true });
    await h.run(8, plus(tone(220, 0.3), noise(0.005)));
    expect(h.snap().scoredFrames).toBeGreaterThan(0.95 * 8 * 60);
  });
});

describe('hidden reference vocals are never audible', () => {
  it('stays paused while the song plays before the mic/graph is ready', async () => {
    const h = await setupHook(useVocalsComparison, { isPlaying: true, start: false });
    const ref = state.audios[0];
    expect(ref).toBeDefined();
    expect(ref.paused).toBe(true);          // would have been full-volume original vocals
    await h.start();                        // mic + capture into the analysis graph
    expect(ref.paused).toBe(false);         // now playing, but captured (silent)
    await h.set({ isPlaying: false });
    expect(ref.paused).toBe(true);          // pause still follows the song
    await h.set({ isPlaying: true });
    expect(ref.paused).toBe(false);
  });

  it('never plays at all if the mic never starts (permission refused)', async () => {
    const h = await setupHook(useVocalsComparison, { isPlaying: true, start: false });
    await h.set({ isPlaying: false });
    await h.set({ isPlaying: true });
    expect(state.audios[0].paused).toBe(true);
  });
});

describe('no-intro worst case', () => {
  it('a humming room cannot show a score even when lyrics start immediately', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: true });
    await h.run(20, plus(tone(120, 0.05), noise(0.005)));
    const s = h.snap();
    // Up to ~0.5 s of hum can slip through before the room is learned, but
    // that is far below the 3 s of singing needed before anything is scored.
    expect(s.scoredFrames).toBeLessThan(60);
    expect(s.total).toBe(0);
    expect(s.accuracy).toBeNull();
  });
});
