import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  durationToSeconds, normalizeSongTitle, primaryArtist, sameSong, unusualVersionWord,
  lengthPenalty, isLongVersion,
} from '@/lib/searchGrouping';

describe('searchGrouping rules', () => {
  it('parses durations', () => {
    expect(durationToSeconds('4:13')).toBe(253);
    expect(durationToSeconds('1:02:03')).toBe(3723);
    expect(durationToSeconds(250)).toBe(250);
    expect(durationToSeconds('')).toBeUndefined();
    expect(durationToSeconds('abc')).toBeUndefined();
  });
  it('normalises titles: drops (From ...) tags and punctuation, keeps other qualifiers', () => {
    expect(normalizeSongTitle('He Ram He Ram (From "Shukrana - The Best Of Jagjit Singh Ever - Vol 2")')).toBe('he ram he ram');
    expect(normalizeSongTitle('Tum Hi Ho [From "Aashiqui 2"]')).toBe('tum hi ho');
    expect(normalizeSongTitle('Kesariya - From "Brahmastra"')).toBe('kesariya');
    expect(normalizeSongTitle('Tum Hi Ho (Female Version)')).toBe('tum hi ho female version');
  });
  it('primary artist is the first listed', () => {
    expect(primaryArtist('Jagjit Singh, Chitra Singh')).toBe('jagjit singh');
    expect(primaryArtist('Arijit Singh & Shreya Ghoshal')).toBe('arijit singh');
    expect(primaryArtist('Badshah feat. Aastha Gill')).toBe('badshah');
  });
  it('same song: same title, primary artist and length within 5 s', () => {
    const a = { title: 'He Ram He Ram (From "Shukrana")', artist: 'Jagjit Singh', duration: '26:57' };
    expect(sameSong(a, { title: 'He Ram He Ram', artist: 'Jagjit Singh', duration: '27:01' })).toBe(true);
    expect(sameSong(a, { title: 'He Ram He Ram', artist: 'Jagjit Singh', duration: '4:13' })).toBe(false);
    expect(sameSong(a, { title: 'He Ram He Ram', artist: 'Anup Jalota', duration: '26:57' })).toBe(false);
    expect(sameSong(a, { title: 'He Ram He Ram', artist: 'Jagjit Singh', duration: '' })).toBe(false);
    expect(sameSong({ title: 'Tum Hi Ho', artist: 'Arijit Singh', duration: '4:22' },
                     { title: 'Tum Hi Ho (Female Version)', artist: 'Arijit Singh', duration: '4:22' })).toBe(false);
  });
  it('unusual versions are flagged unless the search asks for them', () => {
    expect(unusualVersionWord('Hey Ram Hey Ram - Live', 'he ram')).toBe('live');
    expect(unusualVersionWord('Hey Ram Hey Ram - Live', 'he ram live')).toBeNull();
    expect(unusualVersionWord('Bollywood Medley', 'medley')).toBeNull();
    expect(unusualVersionWord('Olive Garden', 'olive')).toBeNull();          // whole words only
    expect(unusualVersionWord('Tum Hi Ho', 'tum hi ho')).toBeNull();
  });
  it('long versions: penalties and the warning flag', () => {
    expect(lengthPenalty(253, 'he ram')).toBe(0);
    expect(lengthPenalty(9 * 60, 'he ram')).toBe(50);
    expect(lengthPenalty(27 * 60, 'he ram')).toBe(160);
    expect(lengthPenalty(27 * 60, 'he ram full version')).toBe(0);
    expect(lengthPenalty(9 * 60, 'he ram live', 'Hey Ram - Live')).toBe(0);    // the asked-for kind
    expect(lengthPenalty(27 * 60, 'he ram live', 'He Ram He Ram')).toBe(160);  // a different result keeps it
    expect(isLongVersion(27 * 60)).toBe(true);
    expect(isLongVersion(11 * 60)).toBe(false);
  });
  it('the search-music edge function carries an identical copy of these rules', () => {
    const lib = readFileSync(resolve(__dirname, '../searchGrouping.ts'), 'utf8');
    const edge = readFileSync(resolve(__dirname, '../../../supabase/functions/search-music/index.ts'), 'utf8');
    const libBody = lib.slice(lib.indexOf('export const SAME_SONG_DURATION_TOLERANCE_S')).replace(/export /g, '').trim();
    const edgeBody = edge.slice(edge.indexOf('// BEGIN SHARED RULES') + '// BEGIN SHARED RULES'.length, edge.indexOf('// END SHARED RULES')).trim();
    expect(edgeBody).toBe(libBody);
  });
});
