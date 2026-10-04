// =============================================================================
// IndexedDB lyrics cache -- persists lyrics across sessions so repeat plays
// of the same song never need to hit LRCLIB again. Separate DB from the
// audio cache (different data type: JSON vs binary blobs).
// =============================================================================

import type { LyricLine } from './lyricsClient';

const DB_NAME = 'karaokeparty-lyrics';
const DB_VERSION = 1;
const STORE_NAME = 'lyrics';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface CachedLyricsMeta { synced?: boolean; mismatch?: boolean; lrclibId?: number }

/** Lines plus how they were chosen (synced / different version). */
export async function getCachedLyricsEntry(key: string): Promise<{ lyrics: LyricLine[]; meta?: CachedLyricsMeta } | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry || Date.now() - (entry.timestamp || 0) > MAX_AGE_MS) { resolve(null); return; }
        resolve(Array.isArray(entry.lyrics) && entry.lyrics.length > 0 ? { lyrics: entry.lyrics, meta: entry.meta } : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function getCachedLyrics(key: string): Promise<LyricLine[] | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry) { resolve(null); return; }
        // Expire after MAX_AGE_MS
        if (Date.now() - (entry.timestamp || 0) > MAX_AGE_MS) {
          resolve(null);
          return;
        }
        if (Array.isArray(entry.lyrics) && entry.lyrics.length > 0) {
          resolve(entry.lyrics);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheLyrics(key: string, lyrics: LyricLine[], meta?: CachedLyricsMeta): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ lyrics, meta, timestamp: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Swallow -- a failed cache write should never block anything
  }
}
