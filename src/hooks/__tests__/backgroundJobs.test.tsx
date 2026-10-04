// @vitest-environment jsdom
// Background separation jobs (option B): the REAL useVocalSeparation hook with
// the separate-vocals edge function mocked, on a fake clock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

type Reply = { data?: any; error?: { message: string } };
let script: Array<(body: any) => Reply> = [];
const calls: any[] = [];
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: async (_n: string, { body }: any) => {
    calls.push(body);
    const next = script.shift();
    if (!next) throw new Error('no scripted reply for ' + JSON.stringify(body));
    return next(body);
  } } },
}));
import { useVocalSeparation } from '@/hooks/useVocalSeparation';

const DONE = { instrumentalUrl: 'https://s/t/instrumental.mp3', vocalsUrl: 'https://s/t/vocals.mp3', pitchUrl: 'https://s/t/pitch.json', fromCache: false, status: 'done' };
const ok = (data: any) => () => ({ data });
const processing = ok({ status: 'processing', started: true });

async function mount() {
  let latest: any;
  function H() { latest = useVocalSeparation(); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<H />); });
  return { get: () => latest };
}
async function runFor(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); script = []; calls.length = 0; localStorage.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('background separation jobs', () => {
  it('cache hit: one call, immediate result', async () => {
    script = [ok({ ...DONE, fromCache: true })];
    const h = await mount(); let res: any;
    await act(async () => { res = await h.get().separateVocals('https://a', 'fast', 't1'); });
    expect(res.instrumentalUrl).toBe(DONE.instrumentalUrl);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ action: 'separate', async: true, trackId: 't1' });
  });

  it('job: polls status every 3 s until done, returns URLs and melody', async () => {
    script = [processing, ok({ status: 'processing' }), ok({ status: 'processing' }), ok(DONE)];
    const h = await mount(); let res: any;
    let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't2', { durationSeconds: 1580 }); });
    await runFor(2900); expect(calls).toHaveLength(1);           // nothing before 3 s
    await runFor(200);  expect(calls).toHaveLength(2);           // first status at 3 s
    await runFor(6000); await act(async () => { res = await p!; });
    expect(calls.map(c => c.action)).toEqual(['separate', 'status', 'status', 'status']);
    expect(res).toMatchObject({ instrumentalUrl: DONE.instrumentalUrl, pitchUrl: DONE.pitchUrl, fromCache: false });
    expect(h.get().separatedAudio.pitchUrl).toBe(DONE.pitchUrl);
  });

  it('failed job: shows the reason, returns null', async () => {
    script = [processing, ok({ status: 'failed', error: 'RuntimeError: GPU OOM' })];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't3'); });
    await runFor(3100); let res: any; await act(async () => { res = await p!; });
    expect(res).toBeNull(); expect(h.get().error).toContain('GPU OOM');
  });

  it('lost job is restarted once, then completes', async () => {
    script = [processing, ok({ status: 'unknown' }), processing, ok(DONE)];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't4'); });
    await runFor(7000); let res: any; await act(async () => { res = await p!; });
    expect(calls.map(c => c.action)).toEqual(['separate', 'status', 'separate', 'status']);
    expect(res.instrumentalUrl).toBe(DONE.instrumentalUrl);
  });

  it('lost twice: gives up with a clear message', async () => {
    script = [processing, ok({ status: 'unknown' }), processing, ok({ status: 'unknown' })];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't5'); });
    await runFor(7000); await act(async () => { await p!; });
    expect(h.get().error).toContain('lost');
  });

  it('tolerates brief network errors while polling', async () => {
    const netErr = () => ({ error: { message: 'Failed to fetch' } });
    script = [processing, netErr, netErr, netErr, netErr, ok(DONE)];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't6'); });
    await runFor(16000); let res: any; await act(async () => { res = await p!; });
    expect(res.instrumentalUrl).toBe(DONE.instrumentalUrl);
  });

  it('gives up after 5 consecutive polling errors', async () => {
    const netErr = () => ({ error: { message: 'Failed to fetch' } });
    script = [processing, netErr, netErr, netErr, netErr, netErr];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't7'); });
    await runFor(16000); await act(async () => { await p!; });
    expect(h.get().error).toContain('Failed to fetch');
  });

  it('leaving the page stops polling without showing an error', async () => {
    script = [processing, ok({ status: 'processing' })];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't8'); });
    await runFor(3100);
    await act(async () => { h.get().reset(); });
    let res: any; await act(async () => { res = await p!; });
    await runFor(30000);
    expect(res).toBeNull(); expect(h.get().error).toBeNull();
    expect(calls).toHaveLength(2);                                // no polling after reset
  });

  it('gives up after 15 minutes', async () => {
    script = [processing, ...Array.from({ length: 400 }, () => ok({ status: 'processing' }))];
    const h = await mount(); let p: Promise<any>;
    await act(async () => { p = h.get().separateVocals('https://a', 'fast', 't9'); });
    await runFor(15 * 60 * 1000 + 5000); await act(async () => { await p!; });
    expect(h.get().error).toContain('too long');
  });

  it('two callers for the same song share one job', async () => {
    script = [processing, ok(DONE)];
    const h1 = await mount(); const h2 = await mount();
    let p1: Promise<any>, p2: Promise<any>;
    await act(async () => { p1 = h1.get().separateVocals('https://a', 'fast', 't10'); p2 = h2.get().separateVocals('https://a', 'fast', 't10'); });
    await runFor(3100); let r1: any, r2: any; await act(async () => { r1 = await p1!; r2 = await p2!; });
    expect(calls).toHaveLength(2); expect(r1.instrumentalUrl).toBe(r2.instrumentalUrl);
  });
});
