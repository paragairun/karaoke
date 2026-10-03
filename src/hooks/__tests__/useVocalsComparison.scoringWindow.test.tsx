// @vitest-environment jsdom
// Hook-level test of the scoring window (lyrics started / vocal section /
// playing). Real useVocalsComparison loop with mocked audio (audioHarness).
// The mic is a quiet room until the singer sings a tone matching the
// reference — the worst case for leakage is covered in silentSinger.test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { installAudioMocks, setupHook, noise, tone, plus } from './audioHarness';

vi.mock('@/lib/audioPermissions', async () => (await import('./audioHarness')).audioPermissionsMock);
import { useVocalsComparison } from '@/hooks/useVocalsComparison';

const room = noise(0.005);
const singing = plus(tone(220, 0.3), room); // in tune with the 220 Hz reference

beforeEach(() => installAudioMocks());

describe('useVocalsComparison scoring window', () => {
  it('scores NOTHING while scoringEnabled=false, even while singing in tune', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: false });
    await h.run(2, room);
    await h.run(4, singing);
    const m = h.get().metrics;
    expect(m.referenceActive).toBe(true);   // detection still runs
    expect(m.scoringNow).toBe(false);
    const s = h.snap();
    expect(s.refActiveFrames).toBe(0);
    expect(s.scoredFrames).toBe(0);
    expect(s.total).toBe(0);
  });

  it('starts scoring once the window opens (lyrics start)', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: false });
    await h.run(2, room);
    await h.set({ scoringEnabled: true });
    await h.run(4, singing);
    const s = h.snap();
    expect(s.refActiveFrames).toBe(240);    // exactly the frames after opening
    expect(s.scoredFrames).toBe(240);
    expect(s.accuracy!).toBeGreaterThan(95);
    expect(s.total).toBeGreaterThan(0);
  });

  it('pauses scoring when the window closes, without resetting', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: true });
    await h.run(2, room);
    await h.run(4, singing);
    const before = h.snap();
    await h.set({ scoringEnabled: false });
    await h.run(2);
    expect(h.snap().refActiveFrames).toBe(before.refActiveFrames);
    expect(h.snap().total).toBe(before.total);
  });

  it('scores nothing while the song is paused (isPlaying=false)', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: true, isPlaying: false });
    await h.run(2, room);
    await h.run(4, singing);
    expect(h.snap().refActiveFrames).toBe(0);
  });

  it('undefined scoringEnabled keeps the window open', async () => {
    const h = await setupHook(useVocalsComparison, {});
    await h.run(1, room);
    // startAnalysis() runs one frame itself before the rAF loop -> 1 + 60
    expect(h.snap().refActiveFrames).toBe(61);
  });

  it('resetAccumulators clears the session', async () => {
    const h = await setupHook(useVocalsComparison, { scoringEnabled: true });
    await h.run(2, room);
    await h.run(4, singing);
    expect(h.snap().total).toBeGreaterThan(0);
    await act(async () => { h.get().resetAccumulators(); });
    expect(h.snap().refActiveFrames).toBe(0);
    expect(h.get().metrics.totalScore).toBe(0);
  });
});
