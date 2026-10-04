// @vitest-environment jsdom
// Reference melody (pitch.json) vs live detection on the vocal stem.
// Real useVocalsComparison loop, mocked Web Audio (audioHarness.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installAudioMocks, setupHook, state, noise, tone, plus } from './audioHarness';

vi.mock('@/lib/audioPermissions', async () => (await import('./audioHarness')).audioPermissionsMock);
import { useVocalsComparison } from '@/hooks/useVocalsComparison';

const URL = 'https://store/t1/pitch.json';
const A3 = 5700;                                    // MIDI 57 x 100 = 220 Hz
const room = noise(0.005);
const singerInTune = plus(tone(220, 0.3), room);
// Separation leftovers: the vocal stem carries a LOUDER wrong-pitch tone on
// top of the real 220 Hz voice. 311 Hz (a tritone up, ratio ~sqrt 2) is NOT
// harmonically related to 220 Hz — a related tone such as 330 Hz (3:2) would
// combine into a 110 Hz pattern that octave-folds back to a "perfect" match
// and hide the problem.
const pollutedStem = plus(tone(311, 0.3), tone(220, 0.15));

/** Melody covering `seconds`, singing 220 Hz except inside `gaps` (seconds). */
function melody(seconds: number, gaps: Array<[number, number]> = []) {
  const n = Math.round(seconds / 0.02) + 1;
  const c = Array.from({ length: n }, (_, i) => (gaps.some(([a, b]) => i * 0.02 >= a && i * 0.02 < b) ? 0 : A3));
  return { v: 1, hop_ms: 20, n, c };
}

async function sing(opts: { url?: string }) {
  const h = await setupHook(useVocalsComparison, { scoringEnabled: true, referencePitchUrl: opts.url });
  await h.run(1, room);          // singer silent for a moment (room learned)
  await h.run(6, singerInTune);  // then sings in tune with the original (220 Hz)
  return h.snap();
}

beforeEach(() => { installAudioMocks(); state.ref = pollutedStem; });

describe('reference melody', () => {
  it('on a polluted stem, the melody scores an in-tune singer correctly where live detection does not', async () => {
    const live = (await sing({})).accuracy!;                 // control: live detection on the stem
    installAudioMocks(); state.ref = pollutedStem;
    state.files[URL] = melody(10);
    const withMelody = (await sing({ url: URL })).accuracy!; // same singer, same stem, melody reference
    console.info(`in-tune singer, polluted stem: live detection ${live.toFixed(1)} vs melody ${withMelody.toFixed(1)}`);
    expect(withMelody).toBeGreaterThan(95);
    expect(withMelody - live).toBeGreaterThan(10);
  });

  it('where the melody says the original singer is silent, nothing is scored (even if the stem is loud)', async () => {
    state.files[URL] = melody(10, [[0, 10]]);   // singer silent for the whole clip per the melody
    const s = await sing({ url: URL });
    expect(s.refActiveFrames).toBe(0);
    expect(s.scoredFrames).toBe(0);
  });

  it('melody gaps are respected inside a song', async () => {
    state.files[URL] = melody(10, [[3, 5]]);    // 2 s instrumental break per the melody
    const h = await setupHook(useVocalsComparison, { scoringEnabled: true, referencePitchUrl: URL });
    await h.run(1, room);
    await h.run(6, singerInTune);               // singing straight through the break
    const s = h.snap();
    // The original singer is active for the whole 7 s (including the first
    // second, while you were silent) minus the 2 s break; +1 frame that
    // startAnalysis() runs itself.
    const expectedActive = 7 * 60 - 2 * 60 + 1;
    expect(Math.abs(s.refActiveFrames - expectedActive)).toBeLessThanOrEqual(2);
  });

  it('a missing melody falls back to live detection', async () => {
    const s = await sing({ url: 'https://store/missing/pitch.json' });   // 404
    expect(s.scoredFrames).toBeGreaterThan(0);                           // still scores, via live detection
  });

  it('a malformed melody falls back to live detection', async () => {
    state.files[URL] = { v: 1, hop_ms: 20, c: ['oops'] };
    const s = await sing({ url: URL });
    expect(s.scoredFrames).toBeGreaterThan(0);
  });
});
