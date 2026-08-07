import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFavoriteIntent,
  clearJournal,
  clearProgressIntent,
  readJournal,
  recordFavoriteIntent,
  recordProgressIntent,
} from '../src/db/journal';

/**
 * The write-ahead journal.
 *
 * What it exists for is unobservable from the app: an intent recorded in a tap
 * handler has to survive the document being discarded before IndexedDB commits.
 * These tests stand in for that by checking the two properties that make the
 * replay correct — the entry is written synchronously, and it is only dropped
 * by the write it actually belongs to.
 */

describe('journal', () => {
  beforeEach(() => {
    clearJournal();
  });

  it('records a favourite intent synchronously', () => {
    recordFavoriteIntent('local:abc', 'add');

    // No await anywhere: by the time the call returns the entry is in storage,
    // which is the entire point of using localStorage over IndexedDB here.
    expect(readJournal().favorites['local:abc']?.op).toBe('add');
  });

  it('keeps removals distinct from additions', () => {
    recordFavoriteIntent('local:abc', 'add');
    recordFavoriteIntent('local:abc', 'remove');

    expect(readJournal().favorites['local:abc']?.op).toBe('remove');
  });

  it('drops an intent once its own write lands', () => {
    const at = recordFavoriteIntent('local:abc', 'add');
    clearFavoriteIntent('local:abc', at);

    expect(readJournal().favorites['local:abc']).toBeUndefined();
  });

  it('does not let a stale write clear a newer intent', () => {
    // Toggle twice in quick succession: the first write completes after the
    // second tap. Clearing on the older timestamp would lose the second tap.
    const first = recordFavoriteIntent('local:abc', 'add');
    const second = recordFavoriteIntent('local:abc', 'remove');
    expect(second).toBeGreaterThanOrEqual(first);

    clearFavoriteIntent('local:abc', first);

    expect(readJournal().favorites['local:abc']?.op).toBe('remove');
  });

  it('journals reading position and clears it on the matching write', () => {
    const entry = {
      chapterId: 'local:ch1',
      comicId: 'local:c1',
      pageIndex: 12,
      pageCount: 40,
      updatedAt: 1000,
    };
    recordProgressIntent(entry);
    expect(readJournal().progress['local:ch1']?.pageIndex).toBe(12);

    clearProgressIntent('local:ch1', 999);
    expect(readJournal().progress['local:ch1']?.pageIndex).toBe(12);

    clearProgressIntent('local:ch1', 1000);
    expect(readJournal().progress['local:ch1']).toBeUndefined();
  });

  it('survives a corrupt payload rather than throwing at startup', () => {
    localStorage.setItem('comic.journal.v1', '{not json');

    expect(readJournal()).toEqual({ favorites: {}, progress: {} });
  });

  it('removes its key once empty so it does not linger', () => {
    const at = recordFavoriteIntent('local:abc', 'add');
    expect(localStorage.getItem('comic.journal.v1')).not.toBeNull();

    clearFavoriteIntent('local:abc', at);
    expect(localStorage.getItem('comic.journal.v1')).toBeNull();
  });
});
