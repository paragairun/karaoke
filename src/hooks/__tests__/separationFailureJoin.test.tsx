// @vitest-environment jsdom
// Index.tsx starts a separation and Sing.tsx joins the same in-flight request
// (two useVocalSeparation instances). The joiner must get the failure too —
// before v9 it got only null, so the Sing page's wait screen never ended.
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

const DONE = { instrumentalUrl: 'https://m/t/instrumental.mp3', vocalsUrl: 'https://m/t/vocals.mp3', fromCache: false, status: 'done' };
const ok = (data: any) => () => ({ data });

async function mount() {
  let latest: any;
  function H() { latest = useVocalSeparation(); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<H />); });
  return { get: () => latest };
}
const runFor = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); script = []; calls.length = 0; localStorage.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('separation shared between search page and Sing page', () => {
  it('joiner receives the failure message', async () => {
    script = [ok({ status: 'processing', started: true }), ok({ status: 'failed', error: 'Modal /jobs 502' })];
    const index = await mount(), sing = await mount();
    let pIndex: Promise<any>, pSing: Promise<any>;
    await act(async () => { pIndex = index.get().separateVocals('https://a', 'fast', 'j1'); });
    await act(async () => { pSing = sing.get().separateVocals('https://a', 'fast', 'j1'); });
    await runFor(3100);
    let rSing: any; await act(async () => { await pIndex!; rSing = await pSing!; });
    expect(calls.filter(c => c.action === 'separate')).toHaveLength(1);   // still one request
    expect(rSing).toBeNull();
    expect(sing.get().error).toBe('Modal /jobs 502');
    expect(sing.get().isProcessing).toBe(false);
  });

  it('joiner receives the result on success', async () => {
    script = [ok({ status: 'processing', started: true }), ok(DONE)];
    const index = await mount(), sing = await mount();
    let pSing: Promise<any>;
    await act(async () => { index.get().separateVocals('https://a', 'fast', 'j2'); });
    await act(async () => { pSing = sing.get().separateVocals('https://a', 'fast', 'j2'); });
    await runFor(3100); let r: any; await act(async () => { r = await pSing!; });
    expect(r.instrumentalUrl).toBe(DONE.instrumentalUrl);
    expect(sing.get().separatedAudio.vocalsUrl).toBe(DONE.vocalsUrl);
    expect(sing.get().error).toBeNull();
  });

  it('if the starter stops waiting (reset), the joiner runs its own separation', async () => {
    script = [ok({ status: 'processing', started: true }), ok({ ...DONE, fromCache: true })];
    const index = await mount(), sing = await mount();
    let pSing: Promise<any>;
    await act(async () => { index.get().separateVocals('https://a', 'fast', 'j3'); });
    await act(async () => { pSing = sing.get().separateVocals('https://a', 'fast', 'j3'); });
    await act(async () => { index.get().reset(); });
    await runFor(100); let r: any; await act(async () => { r = await pSing!; });
    expect(calls.map(c => c.action)).toEqual(['separate', 'separate']);
    expect(r.instrumentalUrl).toBe(DONE.instrumentalUrl);
    expect(sing.get().error).toBeNull();
  });

  it('retry after failure clears the error and can succeed', async () => {
    script = [ok({ error: 'Vocal separation failed' }), ok({ ...DONE, fromCache: true })];
    const sing = await mount();
    await act(async () => { await sing.get().separateVocals('https://a', 'fast', 'j4'); });
    expect(sing.get().error).toBe('Vocal separation failed');
    await act(async () => { await sing.get().separateVocals('https://a', 'fast', 'j4'); });
    expect(sing.get().error).toBeNull();
    expect(sing.get().separatedAudio.instrumentalUrl).toBe(DONE.instrumentalUrl);
  });
});
