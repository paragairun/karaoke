import { describe, it, expect } from 'vitest';
import {
  SessionScorer, ScoreFrame, centsDiff, combineScore, detectPitchAC, onsetCredit,
  ratingForScore, scorePitchFrame, sineBuffer, stabilityScore, SCORE_WEIGHTS,
} from '@/lib/vocalScoring';

const semis = (base: number, s: number) => base * Math.pow(2, s / 12);

/** Feed `seconds` of frames at `fps`; `make(tSec)` returns the frame fields. */
function run(scorer: SessionScorer, seconds: number, fps: number, make: (tSec: number) => Partial<ScoreFrame>, t0 = 0) {
  const dt = 1000 / fps;
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    scorer.frame({ t, scoringOpen: true, refActive: true, refPitch: 220, userVoiced: true, userPitch: 220, ...make(t / 1000) });
  }
  return t0 + n * dt;
}

describe('pitch helpers', () => {
  it('detects a sine wave pitch', () => {
    const hz = detectPitchAC(sineBuffer(220, 48000, 2048), 48000);
    expect(Math.abs(hz - 220)).toBeLessThan(2);
  });
  it('returns 0 for silence', () => {
    expect(detectPitchAC(new Float32Array(2048), 48000)).toBe(0);
  });
  it('folds octaves', () => {
    expect(centsDiff(440, 220)).toBeCloseTo(0, 5);
    expect(centsDiff(semis(220, 1), 220)).toBeCloseTo(100, 5);
  });
  it('pitch credit curve', () => {
    const at = (c: number) => scorePitchFrame(220 * Math.pow(2, c / 1200), 220);
    expect(at(0)).toBe(100);
    expect(at(100)).toBeCloseTo(85, 5);
    expect(at(200)).toBeCloseTo(45, 5);
    expect(at(400)).toBeCloseTo(10, 5);
    expect(at(600)).toBe(5);
    expect(at(1200)).toBe(100); // octave
  });
});

describe('flow, stability, combine, rating', () => {
  it('onset credit curve', () => {
    expect(onsetCredit(0)).toBe(1);
    expect(onsetCredit(-200)).toBeCloseTo(0.5, 5);
    expect(onsetCredit(400)).toBeCloseTo(0.1, 5);
    expect(onsetCredit(401)).toBe(0);
  });
  it('stability mapping', () => {
    expect(stabilityScore(0)).toBe(100);
    expect(stabilityScore(600)).toBe(100);
    expect(stabilityScore(1500)).toBeCloseTo(50, 5);
    expect(stabilityScore(2400)).toBe(0);
  });
  it('weights sum to 1 and combine renormalises missing components', () => {
    expect(SCORE_WEIGHTS.accuracy + SCORE_WEIGHTS.flow + SCORE_WEIGHTS.expression).toBeCloseTo(1, 10);
    expect(combineScore({ accuracy: 71, flow: 45, expression: 53 })).toBe(600);
    expect(combineScore({ accuracy: 80, flow: null, expression: 50 })).toBe(700); // (40+12.5)/0.75*10
    expect(combineScore({ accuracy: null, flow: 90, expression: 90 })).toBe(0);
  });
  it('rating thresholds', () => {
    expect([900, 899, 800, 700, 600, 500, 300, 299].map(ratingForScore)).toEqual(['L', 'S', 'S', 'A', 'B', 'C', 'D', 'F']);
  });
});

describe('SessionScorer', () => {
  it('scores nothing while the window is closed, even if loud and in tune', () => {
    const s = new SessionScorer();
    run(s, 5, 60, () => ({ scoringOpen: false }));
    const snap = s.snapshot();
    expect(snap.scoredFrames).toBe(0);
    expect(snap.total).toBe(0);
    expect(snap.accuracy).toBeNull();
  });

  it('Accuracy is a true average: order of good/bad halves does not matter', () => {
    const a = new SessionScorer();
    run(a, 60, 60, t => ({ userPitch: t < 30 ? 220 : semis(220, 6) }));
    const b = new SessionScorer();
    run(b, 60, 60, t => ({ userPitch: t < 30 ? semis(220, 6) : 220 }));
    expect(a.snapshot().accuracy).toBeCloseTo(52.5, 1); // (100 + 5) / 2
    expect(b.snapshot().accuracy).toBeCloseTo(a.snapshot().accuracy!, 6);
  });

  it('silence while the singer sings earns nothing but lowers presence', () => {
    const s = new SessionScorer();
    run(s, 10, 60, t => ({ userVoiced: t < 5, userPitch: t < 5 ? 220 : 0 }));
    const snap = s.snapshot();
    expect(snap.accuracy).toBeCloseTo(100, 5);     // only voiced frames count
    expect(snap.completion).toBeCloseTo(0.5, 2);
    expect(snap.expression).toBeCloseTo(0.6 * 50 + 0.4 * 100, 0);
  });

  it('a perfectly sung moving melody keeps full steadiness', () => {
    const notes = [0, 2, 4, 5, 7, 5, 4, 2, 0, 2];
    const s = new SessionScorer();
    run(s, 10, 60, t => { const p = semis(220, notes[Math.floor(t) % 10]); return { refPitch: p, userPitch: p }; });
    expect(s.snapshot().expression).toBeCloseTo(100, 0);
    expect(s.snapshot().accuracy).toBeCloseTo(100, 5);
  });

  it('steadiness ranks steady > vibrato > mild jitter > clearly unsteady', () => {
    const expr = (make: (t: number) => number) => {
      const s = new SessionScorer();
      run(s, 10, 60, t => ({ userPitch: make(t) }));
      return s.snapshot().expression!;
    };
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const steady = expr(() => 220);
    const vibrato = expr(t => semis(220, 0.4 * Math.sin(2 * Math.PI * 5.5 * t))); // 5.5 Hz, +-40 cents
    const mild = expr(() => semis(220, 0.3 * rnd()));    // random +-30 cents every frame
    const unsteady = expr(() => semis(220, 0.6 * rnd())); // random +-60 cents every frame
    console.info(`expression: steady=${steady.toFixed(1)} vibrato=${vibrato.toFixed(1)} mild-jitter=${mild.toFixed(1)} unsteady=${unsteady.toFixed(1)}`);
    expect(steady).toBeCloseTo(100, 5);
    expect(vibrato).toBeGreaterThan(90);
    expect(vibrato).toBeGreaterThan(mild);
    expect(mild).toBeGreaterThan(unsteady);
    // Expression = 60 x presence + 0.4 x steadiness; presence is full here, so
    // steadiness = (expression - 60) / 0.4. Clearly unsteady keeps < 30% of it.
    expect((unsteady - 60) / 0.4).toBeLessThan(30);
  });

  it('steadiness does not depend on frame rate', () => {
    const at = (fps: number) => {
      const s = new SessionScorer();
      run(s, 10, fps, t => ({ userPitch: semis(220, 0.4 * Math.sin(2 * Math.PI * 5.5 * t)) }));
      return s.snapshot().expression!;
    };
    expect(Math.abs(at(60) - at(120))).toBeLessThan(2);
  });

  it('Flow: null before any phrase start, then credited per reference phrase start', () => {
    const s = new SessionScorer();
    run(s, 0.3, 60, () => ({}));
    expect(s.snapshot().flow).toBeNull(); // window for the first phrase start not passed yet
    // 5 phrases: 1 s on, 0.5 s off. You start each one 200 ms late.
    const s2 = new SessionScorer();
    let t = 0;
    for (let p = 0; p < 5; p++) {
      t = run(s2, 1, 60, tt => ({ refActive: true, userVoiced: tt * 1000 - t >= 200 }), t);
      t = run(s2, 0.5, 60, () => ({ refActive: false, userVoiced: false }), t);
    }
    s2.finalize(t);
    expect(s2.snapshot().flow).toBeCloseTo(50, 0); // 200 ms late = 50% credit
  });

  it('Flow ignores your extra phrase starts and is not capped by session length', () => {
    const s = new SessionScorer();
    let t = 0;
    for (let p = 0; p < 400; p++) { // 400 phrases (old code kept only the last 200)
      t = run(s, 0.5, 60, () => ({ refActive: true, userVoiced: true }), t);
      t = run(s, 0.2, 60, () => ({ refActive: false, userVoiced: false }), t);
    }
    s.finalize(t);
    expect(s.snapshot().flow).toBeCloseTo(100, 0);
  });

  it('reset clears everything', () => {
    const s = new SessionScorer();
    run(s, 2, 60, () => ({}));
    s.reset();
    expect(s.snapshot()).toMatchObject({ accuracy: null, flow: null, expression: null, total: 0, scoredFrames: 0 });
  });
});
