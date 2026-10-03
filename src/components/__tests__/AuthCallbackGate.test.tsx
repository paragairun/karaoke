// @vitest-environment jsdom
// Real AuthCallbackGate with Supabase's auth events mocked: verifies that a
// Google sign-in return lands on the stored page with the token removed from
// the URL (clean-URL routing, no hash writes).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

let authCb: ((event: string) => void) | null = null;
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { onAuthStateChange: (cb: (e: string) => void) => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; } } },
}));
import { AuthCallbackGate } from '@/components/AuthCallbackGate';

async function mount() {
  const el = document.createElement('div'); document.body.appendChild(el);
  await act(async () => { createRoot(el).render(<AuthCallbackGate><p>app</p></AuthCallbackGate>); });
  return el;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  authCb = null; sessionStorage.clear(); document.body.innerHTML = '';
});

describe('AuthCallbackGate (clean URLs)', () => {
  it('after sign-in, goes to the stored page and removes the token from the URL', async () => {
    window.history.replaceState(null, '', '/#access_token=abc&token_type=bearer');
    sessionStorage.setItem('authRedirectTo', '/party/host');
    const el = await mount();
    expect(el.textContent).not.toContain('app');           // app held back while signing in
    await act(async () => { authCb!('SIGNED_IN'); });
    expect(window.location.pathname).toBe('/party/host');
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('authRedirectTo')).toBeNull();
    expect(el.textContent).toContain('app');
  });

  it('without a stored target, stays on the current page and removes the token', async () => {
    window.history.replaceState(null, '', '/leaderboard#access_token=abc');
    const el = await mount();
    await act(async () => { authCb!('SIGNED_IN'); });
    expect(window.location.pathname).toBe('/leaderboard');
    expect(window.location.hash).toBe('');
    expect(el.textContent).toContain('app');
  });

  it('normal visits render immediately and never touch the URL', async () => {
    window.history.replaceState(null, '', '/leaderboard');
    const el = await mount();
    expect(el.textContent).toContain('app');
    expect(window.location.pathname).toBe('/leaderboard');
  });
});
