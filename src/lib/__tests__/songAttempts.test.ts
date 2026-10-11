// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getVisitorId, detectDevice, startSongAttempt, getSongAttempt, sendAttemptEvent } from '@/lib/songAttempts';

const sent: Array<{ url: string; init: RequestInit }> = [];
beforeEach(() => {
  sent.length = 0; localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(null, { status: 204 }); }));
});
const bodies = () => sent.map(s => JSON.parse(String(s.init.body)));

const track = { id: 'Tk_1', title: 'Kesariya', artist: 'Arijit Singh', album: 'Brahmastra', source: 'saavn', durationSeconds: 268, ready: true };

describe('songAttempts', () => {
  it('visitor id is stable per browser and valid for the server', () => {
    const a = getVisitorId(), b = getVisitorId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('detects devices', () => {
    expect(detectDevice('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe('mobile');
    expect(detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(detectDevice('Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 Chrome/120 Safari/537.36')).toBe('tablet');
    expect(detectDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(detectDevice('Mozilla/5.0 (Linux; Android 11; BRAVIA 4K VH2 Build/RTM6) Chrome/120 Safari/537.36')).toBe('tv');
    expect(detectDevice('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36')).toBe('tv');
    expect(detectDevice('Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36')).toBe('tv');
    expect(detectDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36')).toBe('desktop');
  });

  it('click: posts one text/plain keepalive request with the song details', () => {
    const a = startSongAttempt(track, { query: 'kesariya', position: 3, isAlt: false, accessToken: 'tok' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/functions\/v1\/song-attempts$/);
    expect((sent[0].init.headers as Record<string, string>)['Content-Type']).toBe('text/plain;charset=UTF-8');
    expect(sent[0].init.keepalive).toBe(true);
    expect(bodies()[0]).toMatchObject({
      id: a.id, visitorId: getVisitorId(), event: 'click',
      data: { track: { id: 'Tk_1', title: 'Kesariya', source: 'saavn', durationSeconds: 268 }, wasReady: true, isAlt: false, query: 'kesariya', position: 3, token: 'tok' },
    });
  });

  it('Sing page finds the attempt only for the same track', () => {
    const a = startSongAttempt(track, {});
    expect(getSongAttempt('Tk_1')?.id).toBe(a.id);
    expect(getSongAttempt('other')).toBeNull();
    expect(getSongAttempt(undefined)).toBeNull();
  });

  it('events carry id + visitor id; nothing is sent without an attempt', () => {
    const a = startSongAttempt(track, {});
    sendAttemptEvent(a, 'feedback', { answer: 'no' });
    sendAttemptEvent(null, 'playing');
    expect(bodies().slice(1)).toEqual([{ id: a.id, visitorId: getVisitorId(), event: 'feedback', data: { answer: 'no' } }]);
  });

  it('leaving uses sendBeacon when available', () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon, userAgent: navigator.userAgent });
    const a = startSongAttempt(track, {});
    sendAttemptEvent(a, 'left', { stage: 'waiting' }, { beacon: true });
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);   // only the click went through fetch
    vi.unstubAllGlobals();
  });

  it('a failing network never throws', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect(() => startSongAttempt(track, {})).not.toThrow();
  });
});
