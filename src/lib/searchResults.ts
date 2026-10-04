// src/lib/searchResults.ts
// =============================================================================
// Homepage results arrive per source (JioSaavn, Gaana, YouTube) and are shown
// as they land, never re-sorted, so nothing jumps while the user reads. The
// edge function merges duplicate versions WITHIN a source; this merges a later
// source's copy of a song already on screen INTO that row (as another
// version) instead of adding a duplicate row. Rows never move: a Ready copy
// (already separated) takes over the row's content in the same position.
// =============================================================================

import { sameSong, type Songish } from '@/lib/searchGrouping';

export const MAX_ALT_VERSIONS = 6;

export interface ResultRow extends Songish {
  id: string;
  ready?: boolean;
  altVersions?: ResultRow[];
}

const withoutAlts = <T extends ResultRow>(t: T): T => {
  const { altVersions: _drop, ...rest } = t;
  return rest as T;
};

/** Returns a new rows array with `incoming` merged in (rows keep their order). */
export function mergeResultRows<T extends ResultRow>(rows: T[], incoming: T[]): T[] {
  const out = rows.slice();
  for (const t of incoming) {
    const i = out.findIndex(r => r.id === t.id || sameSong(r, t));
    if (i < 0) { out.push(t); continue; }
    const row = out[i];
    if (row.id === t.id) continue;
    const alts = [...(row.altVersions ?? []), ...(t.altVersions ?? [])] as T[];
    out[i] = (t.ready && !row.ready)
      ? { ...t, altVersions: [withoutAlts(row), ...alts].slice(0, MAX_ALT_VERSIONS) }
      : { ...row, altVersions: [...alts, withoutAlts(t)].slice(0, MAX_ALT_VERSIONS) };
  }
  return out;
}
