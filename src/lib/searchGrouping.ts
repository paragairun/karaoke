// src/lib/searchGrouping.ts
// =============================================================================
// Rules for tidying search results. The search-music edge function keeps an
// identical copy (edge functions can't import from src/); parity is tested in
// src/lib/__tests__/searchGrouping.test.ts. Change both together.
//
// - Duplicate versions: the same recording is often published on several
//   albums/compilations (and on both JioSaavn and Gaana), each with its own
//   id. Results are "the same song" when the title (ignoring "(From ...)"
//   tags and punctuation), the primary artist and the length (within 5 s)
//   all match. Unknown lengths are never merged.
// - Unusual versions (live, medley, remix, ...): ranked lower, unless the
//   search itself asks for that kind of version.
// - Long versions: over 8 min ranked lower; over 12 min ranked lowest of all
//   (its penalty outweighs any other penalty plus the Ready bonus) and
//   flagged with a warning. Not applied when the search asks for a long
//   version, or when this result IS the kind of version the search asks
//   for (a long live version when searching "live"); other results keep it.
// =============================================================================

export const SAME_SONG_DURATION_TOLERANCE_S = 5;
export const LONG_VERSION_S = 12 * 60;       // warning + strong demotion
export const LONGISH_VERSION_S = 8 * 60;     // mild demotion

export const UNUSUAL_VERSION_WORDS = [
  'live', 'medley', 'mashup', 'remix', 'remixed', 'unplugged', 'lofi', 'lo-fi',
  'slowed', 'reverb', 'sped up', '8d', 'reprise', 'recreated', 'rendition',
  'revisited', 'reloaded', 'instrumental', 'karaoke', 'cover', 'jhankar',
  'club mix', 'dj mix', 'acoustic version', 'non-stop', 'nonstop', 'jukebox',
];
const LONG_QUERY_WORDS = /\b(long|extended|full|jukebox|non-?stop|medley|mashup)\b/i;

/** "4:13" / "1:02:03" / 253 -> seconds; undefined if unknown. */
export function durationToSeconds(d: string | number | undefined | null): number | undefined {
  if (typeof d === 'number') return Number.isFinite(d) && d > 0 ? d : undefined;
  if (!d) return undefined;
  const parts = String(d).trim().split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return undefined;
  const s = parts.reduce((acc, n) => acc * 60 + n, 0);
  return s > 0 ? s : undefined;
}

/** Title for comparison: lower case, "(From ...)" tags and punctuation removed. */
export function normalizeSongTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[([]\s*from\b[^)\]]*[)\]]/g, ' ')      // (From "Film") / [From ...]
    .replace(/\s-\s*from\s.*$/g, ' ')                  // - From "Film"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First listed artist, lower case. */
export function primaryArtist(artist: string): string {
  return (artist || '')
    .toLowerCase()
    .split(/,|&|\band\b|\bfeat\.?\b|\bft\.?\b|\bx\b/)[0]
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface Songish { title: string; artist: string; duration?: string | number }

export function sameSong(a: Songish, b: Songish): boolean {
  const da = durationToSeconds(a.duration), db = durationToSeconds(b.duration);
  if (da === undefined || db === undefined) return false;
  if (Math.abs(da - db) > SAME_SONG_DURATION_TOLERANCE_S) return false;
  return normalizeSongTitle(a.title) === normalizeSongTitle(b.title)
    && primaryArtist(a.artist) === primaryArtist(b.artist)
    && normalizeSongTitle(a.title) !== '';
}

const hasWord = (text: string, word: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/** The unusual-version word in the title the user did NOT ask for, or null. */
export function unusualVersionWord(title: string, query: string): string | null {
  for (const w of UNUSUAL_VERSION_WORDS) {
    if (hasWord(title, w) && !hasWord(query, w)) return w;
  }
  return null;
}

/** Ranking penalty for long versions (0 when the search asks for one). */
export function lengthPenalty(durationS: number | undefined, query: string, title = ''): number {
  if (!durationS || LONG_QUERY_WORDS.test(query)) return 0;
  // Searched for live/medley/... and this result is one: those run longer.
  if (UNUSUAL_VERSION_WORDS.some(w => hasWord(query, w) && hasWord(title, w))) return 0;
  if (durationS > LONG_VERSION_S) return 160;   // > unusual (80) + longish (50) + Ready bonus (20)
  if (durationS > LONGISH_VERSION_S) return 50;
  return 0;
}

export function isLongVersion(durationS: number | undefined): boolean {
  return !!durationS && durationS > LONG_VERSION_S;
}
