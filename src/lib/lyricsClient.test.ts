// =============================================================================
// CHANGELOG
// v1 -- NEW. Converts several real-world bugs diagnosed and fixed earlier
//   this session into permanent regression tests: the "Yun Hi Chala Chal"
//   album+duration override case, the "Papaoutai" cover-filtering case, the
//   "Phir Mohabbat" Saavn title-suffix cleanup case, and the core scoring/
//   tiering logic in pickBestResult. These were all manually verified via
//   one-off Python scripts during live debugging -- this file makes that
//   verification permanent and automatic.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseDurationToSeconds,
  detectScript,
  scriptPenalty,
  normalizeAlbum,
  cleanSaavnTitle,
  pickBestResult,
  permutations,
} from './lyricsClient';

describe('parseDurationToSeconds', () => {
  it('parses MM:SS format', () => {
    expect(parseDurationToSeconds('3:45')).toBe(225);
  });
  it('parses HH:MM:SS format', () => {
    expect(parseDurationToSeconds('1:02:03')).toBe(3723);
  });
  it('parses a raw numeric string as seconds', () => {
    expect(parseDurationToSeconds('225')).toBe(225);
  });
  it('parses a raw number as seconds', () => {
    expect(parseDurationToSeconds(225)).toBe(225);
  });
  it('returns undefined for missing input', () => {
    expect(parseDurationToSeconds(undefined)).toBeUndefined();
  });
  it('returns undefined for invalid input', () => {
    expect(parseDurationToSeconds('not-a-duration')).toBeUndefined();
  });
});

describe('cleanSaavnTitle', () => {
  it('strips "(From "Movie")" suffix and extracts the movie as album', () => {
    const result = cleanSaavnTitle('Phir Mohabbat (From "Murder 2")', 'Timeless Love Tunes');
    expect(result.cleanTitle).toBe('Phir Mohabbat');
    expect(result.betterAlbum).toBe('Murder 2');
  });
  it('handles single-quote variant', () => {
    const result = cleanSaavnTitle("Tum Hi Ho (From 'Aashiqui 2')", 'Aashiqui 2');
    expect(result.cleanTitle).toBe('Tum Hi Ho');
    expect(result.betterAlbum).toBe('Aashiqui 2');
  });
  it('handles the dash variant', () => {
    const result = cleanSaavnTitle('Chaiyya Chaiyya - From "Dil Se"', 'Dil Se');
    expect(result.cleanTitle).toBe('Chaiyya Chaiyya');
    expect(result.betterAlbum).toBe('Dil Se');
  });
  it('leaves a title with no suffix unchanged', () => {
    const result = cleanSaavnTitle('Lag Ja Gale', 'Woh Kaun Thi');
    expect(result.cleanTitle).toBe('Lag Ja Gale');
    expect(result.betterAlbum).toBe('Woh Kaun Thi');
  });
  it('leaves a title with no suffix unchanged even without an album', () => {
    const result = cleanSaavnTitle('Tum Hi Ho Bandhu');
    expect(result.cleanTitle).toBe('Tum Hi Ho Bandhu');
  });
  it('strips remix/unplugged-style suffixes', () => {
    const result = cleanSaavnTitle('Kesariya (Unplugged)');
    expect(result.cleanTitle).toBe('Kesariya');
  });
});

describe('normalizeAlbum', () => {
  it('treats "Swades" and its OST-suffixed form as the same album', () => {
    expect(normalizeAlbum('Swades')).toBe(normalizeAlbum('Swades (Original Motion Picture Soundtrack)'));
  });
  it('strips "- Single" suffix', () => {
    expect(normalizeAlbum('Kesariya - Single')).toBe(normalizeAlbum('Kesariya'));
  });
  it('is case-insensitive', () => {
    expect(normalizeAlbum('SWADES')).toBe(normalizeAlbum('swades'));
  });
  it('returns an empty string for null/undefined', () => {
    expect(normalizeAlbum(null)).toBe('');
    expect(normalizeAlbum(undefined)).toBe('');
  });
});

describe('detectScript', () => {
  it('detects Devanagari', () => {
    expect(detectScript('तुम ही हो')).toBe('devanagari');
  });
  it('detects Latin', () => {
    expect(detectScript('Tum Hi Ho')).toBe('latin');
  });
  it('detects Gurmukhi', () => {
    expect(detectScript('ਤੁਮ ਹੀ ਹੋ')).toBe('gurmukhi');
  });
  it('detects dual script when both are significantly present', () => {
    expect(detectScript('Tum Hi Ho तुम ही हो')).toBe('dual');
  });
});

describe('scriptPenalty', () => {
  it('is zero for any script on a non-Hindi song', () => {
    expect(scriptPenalty('gurmukhi', 'english')).toBe(0);
    expect(scriptPenalty('dual', undefined)).toBe(0);
  });
  it('prefers Devanagari over romanised (Latin) lyrics on a Hindi song', () => {
    // Lower penalty wins in pickBestResult: Devanagari 0, romanised 2.
    expect(scriptPenalty('devanagari', 'hindi')).toBe(0);
    expect(scriptPenalty('latin', 'hindi')).toBe(2);
  });
  it('ranks Hindi-song scripts devanagari < latin < unknown < gurmukhi/dual', () => {
    const p = (s: Parameters<typeof scriptPenalty>[0]) => scriptPenalty(s, 'hindi');
    expect(p('devanagari')).toBeLessThan(p('latin'));
    expect(p('latin')).toBeLessThan(p('unknown'));
    expect(p('unknown')).toBeLessThan(p('gurmukhi'));
    expect(p('gurmukhi')).toBe(p('dual'));
  });
  it('penalizes Gurmukhi and dual script on a Hindi song at 5', () => {
    expect(scriptPenalty('gurmukhi', 'hindi')).toBe(5);
    expect(scriptPenalty('dual', 'hindi')).toBe(5);
  });
  it('gives a small penalty for unknown script on a Hindi song', () => {
    expect(scriptPenalty('unknown', 'hindi')).toBe(3);
  });
});

describe('permutations', () => {
  it('returns the single array for a 1-element input', () => {
    expect(permutations(['A'])).toEqual([['A']]);
  });
  it('returns 2 permutations for a 2-element input', () => {
    expect(permutations(['A', 'B'])).toHaveLength(2);
  });
  it('returns 6 permutations for a 3-element input (matches the 3-artist case)', () => {
    expect(permutations(['A', 'B', 'C'])).toHaveLength(6);
  });
});

describe('pickBestResult -- real diagnosed cases', () => {
  it('"Yun Hi Chala Chal": promotes a partial title match confirmed by album+duration over an unrelated exact-ish match', () => {
    const pool = [
      {
        id: 1,
        trackName: 'Yun Hi Chala Chal Rahi',
        artistName: 'Neeraj Shridhar',
        albumName: 'Swades (Original Motion Picture Soundtrack)',
        duration: 446,
        syncedLyrics: '[00:01.00]line one',
      },
      {
        id: 2,
        trackName: 'Yunhi Chala Chal',
        artistName: 'A.R. Rahman',
        albumName: 'Best of A.R. Rahman',
        duration: 447,
        syncedLyrics: '[00:01.00]line two',
      },
    ];
    const result = pickBestResult(pool, 'Yun Hi Chala Chal', 446, undefined, 'Swades');
    expect(result?.trackName).toBe('Yun Hi Chala Chal Rahi');
  });

  it('"Papaoutai": prefers the original over a same-title cover/remix', () => {
    const pool = [
      {
        id: 1,
        trackName: 'Papaoutai',
        artistName: 'Stromae',
        albumName: 'Racine Carree',
        duration: 200,
        syncedLyrics: '[00:01.00]original',
      },
      {
        id: 2,
        trackName: 'Papaoutai (Stromae Cover) (feat. Lindsey Stirling)',
        artistName: 'Lindsey Stirling',
        albumName: 'Covers',
        duration: 195,
        syncedLyrics: '[00:01.00]cover',
      },
    ];
    const result = pickBestResult(pool, 'Papaoutai', 200, undefined);
    expect(result?.trackName).toBe('Papaoutai');
  });

  it('"The Nights": prefers an exact title over a partial match with extra words', () => {
    const pool = [
      {
        id: 1,
        trackName: 'The Nights',
        artistName: 'Avicii',
        duration: 177,
        syncedLyrics: '[00:01.00]exact',
      },
      {
        id: 2,
        trackName: 'Remember the Nights',
        artistName: 'Someone Else',
        duration: 180,
        syncedLyrics: '[00:01.00]partial',
      },
    ];
    const result = pickBestResult(pool, 'The Nights', 177, undefined);
    expect(result?.trackName).toBe('The Nights');
  });

  it('always prefers a synced result over a plain-only result, regardless of title/duration fit', () => {
    const pool = [
      {
        id: 1,
        trackName: 'Some Other Title Entirely',
        duration: 999,
        syncedLyrics: '[00:01.00]synced but weaker match',
      },
      {
        id: 2,
        trackName: 'Exact Title',
        duration: 200,
        plainLyrics: 'plain but perfect match',
      },
    ];
    const result = pickBestResult(pool, 'Exact Title', 200, undefined);
    expect(result?.lyrics[0]?.text).toBe('synced but weaker match');
  });

  it('falls back to plain lyrics when nothing synced exists at all', () => {
    const pool = [
      { id: 1, trackName: 'Exact Title', duration: 200, plainLyrics: 'only plain available' },
    ];
    const result = pickBestResult(pool, 'Exact Title', 200, undefined);
    expect(result?.lyrics[0]?.text).toBe('only plain available');
  });

  it('returns null for an empty pool', () => {
    expect(pickBestResult([], 'Anything', 200, undefined)).toBeNull();
  });

  it('the +/-1s album+duration override does not fire outside that tolerance', () => {
    const pool = [
      {
        id: 1,
        trackName: 'Slightly Different Title',
        albumName: 'Correct Album',
        duration: 250, // 4 seconds off from the requested 246 -- outside +/-1s
        syncedLyrics: '[00:01.00]should not win via album override',
      },
      {
        id: 2,
        trackName: 'Slightly Different Title',
        albumName: 'Wrong Album',
        duration: 246,
        syncedLyrics: '[00:01.00]closer duration but wrong album',
      },
    ];
    const result = pickBestResult(pool, 'Exact Title', 246, undefined, 'Correct Album');
    // Neither should hit Tier 1/2 (no exact title, no confirmed album+duration
    // match) -- falls through to Tier 4 (partial, unconfirmed), ranked by
    // raw duration proximity. Track 2 (246s, dead-on) should win over
    // Track 1 (250s, 4s off), confirming the override didn't fire loosely.
    expect(result?.lyrics[0]?.text).toBe('closer duration but wrong album');
  });
});
