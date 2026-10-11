// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SeparationWaitScreen } from '@/components/SeparationWaitScreen';

const track = { title: 'Kesariya', artist: 'Arijit Singh' };
let host: HTMLDivElement, root: Root;
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const q = (sel: string) => host.querySelector(sel);
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim().includes(text));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); localStorage.clear();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('SeparationWaitScreen feedback prompt', () => {
  it('asks "Is the song loading OK?" after 30 s, once, and records the answer', async () => {
    const onFeedback = vi.fn(), onPromptShown = vi.fn();
    await render(<SeparationWaitScreen track={track} isVisible startedAt={Date.now()} onFeedback={onFeedback} onPromptShown={onPromptShown} />);
    await advance(29_900);
    expect(q('[data-testid="loading-feedback"]')).toBeNull();
    await advance(200);
    expect(q('[data-testid="loading-feedback"]')?.textContent).toContain('Is the song loading OK?');
    expect(onPromptShown).toHaveBeenCalledTimes(1);
    await act(async () => { button('No')!.click(); });
    expect(onFeedback).toHaveBeenCalledWith('no');
    expect(q('[data-testid="loading-feedback"]')?.textContent).toContain('Thanks');
    expect(button('Yes')).toBeUndefined();
    await advance(120_000);
    expect(onPromptShown).toHaveBeenCalledTimes(1);
  });

  it('never asks when the song did not come from a search click (no onFeedback)', async () => {
    await render(<SeparationWaitScreen track={track} isVisible startedAt={Date.now()} />);
    await advance(60_000);
    expect(q('[data-testid="loading-feedback"]')).toBeNull();
  });

  it('does not ask if the screen closes before 30 s', async () => {
    const onPromptShown = vi.fn();
    await render(<SeparationWaitScreen track={track} isVisible startedAt={Date.now()} onFeedback={vi.fn()} onPromptShown={onPromptShown} />);
    await advance(10_000);
    await render(<SeparationWaitScreen track={track} isVisible={false} startedAt={Date.now()} onFeedback={vi.fn()} onPromptShown={onPromptShown} />);
    await advance(60_000);
    expect(onPromptShown).not.toHaveBeenCalled();
  });
});

describe('SeparationWaitScreen failure state', () => {
  it('shows the error with Try again / Pick another song instead of the progress bar', async () => {
    const onRetry = vi.fn(), onPickAnother = vi.fn();
    await render(<SeparationWaitScreen track={track} isVisible startedAt={Date.now()} failedMessage="Modal /jobs 502" onRetry={onRetry} onPickAnother={onPickAnother} onFeedback={vi.fn()} />);
    const panel = q('[data-testid="separation-failed"]');
    expect(panel?.textContent).toContain("We couldn't prepare this song");
    expect(panel?.textContent).toContain('Modal /jobs 502');
    expect(host.textContent).not.toContain('AI Processing');
    await act(async () => { button('Try again')!.click(); });
    await act(async () => { button('Pick another song')!.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1); expect(onPickAnother).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(q('[data-testid="loading-feedback"]')).toBeNull();   // no question while failed
  });

  it('back to the progress bar when the retry starts', async () => {
    await render(<SeparationWaitScreen track={track} isVisible startedAt={Date.now()} failedMessage="x" onRetry={vi.fn()} />);
    await render(<SeparationWaitScreen track={track} isVisible startedAt={Date.now()} failedMessage={null} onRetry={vi.fn()} />);
    expect(q('[data-testid="separation-failed"]')).toBeNull();
    expect(host.textContent).toContain('AI Processing');
  });
});
