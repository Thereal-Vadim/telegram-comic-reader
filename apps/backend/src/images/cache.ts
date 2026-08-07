import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Content-addressed disk cache for transcoded pages.
 *
 * Keys are `sha256(sourceRef + variant + quality)`, so a change to encoder
 * settings produces new keys rather than serving stale bytes from the old
 * settings. Files are sharded into 256 directories by key prefix, because a
 * single flat directory with a few hundred thousand entries makes lookups slow
 * on most filesystems.
 *
 * Eviction is least-recently-used, driven by an in-memory index that is
 * rebuilt from disk at boot. Access times are tracked in the index rather than
 * with `utimes` on every hit; touching the filesystem on every read would cost
 * more than the eviction accuracy is worth.
 */

export interface CacheEntryMeta {
  readonly key: string;
  readonly bytes: number;
  lastAccess: number;
}

export class ImageCache {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #index = new Map<string, CacheEntryMeta>();
  #totalBytes = 0;
  /** Tail of the eviction chain; see {@link #scheduleEvict}. */
  #evicting: Promise<void> = Promise.resolve();

  constructor(dir: string, maxBytes: number) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
  }

  static key(sourceRef: string, variant: string, quality: number): string {
    return crypto.createHash('sha256').update(`${sourceRef}\u0000${variant}\u0000${quality}`).digest('hex');
  }

  #pathFor(key: string): string {
    return path.join(this.#dir, key.slice(0, 2), `${key}.webp`);
  }

  /** Rebuild the index by walking the cache directory. Called once at boot. */
  async init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true });

    let shards: string[];
    try {
      shards = await fs.readdir(this.#dir);
    } catch {
      return;
    }

    for (const shard of shards) {
      const shardDir = path.join(this.#dir, shard);
      let files: string[];
      try {
        const st = await fs.stat(shardDir);
        if (!st.isDirectory()) continue;
        files = await fs.readdir(shardDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.webp')) continue;
        const key = file.slice(0, -'.webp'.length);
        try {
          const st = await fs.stat(path.join(shardDir, file));
          // atimeMs is often unreliable (relatime, noatime mounts), so mtime is
          // the more dependable starting point for recency.
          this.#index.set(key, { key, bytes: st.size, lastAccess: st.mtimeMs });
          this.#totalBytes += st.size;
        } catch {
          // A file that vanished between readdir and stat is simply skipped.
        }
      }
    }
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get entryCount(): number {
    return this.#index.size;
  }

  async get(key: string): Promise<Buffer | null> {
    const meta = this.#index.get(key);
    if (!meta) return null;

    try {
      const buf = await fs.readFile(this.#pathFor(key));
      meta.lastAccess = Date.now();
      return buf;
    } catch {
      // Index says present but the file is gone: repair the index and miss.
      this.#index.delete(key);
      this.#totalBytes -= meta.bytes;
      return null;
    }
  }

  async set(key: string, data: Buffer): Promise<void> {
    const dest = this.#pathFor(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    // Temp-then-rename keeps a concurrent reader from ever seeing a partial file.
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      // A cache write failure must not fail the request; the bytes were served.
      // Swallow it here and leave the entry out of the index.
      void err;
      return;
    }

    const previous = this.#index.get(key);
    if (previous) this.#totalBytes -= previous.bytes;
    this.#index.set(key, { key, bytes: data.byteLength, lastAccess: Date.now() });
    this.#totalBytes += data.byteLength;

    // Awaited rather than fired and forgotten: a caller that has just written
    // needs the cache to be back under its cap before it returns, otherwise a
    // burst of writes leaves it permanently over.
    if (this.#totalBytes > this.#maxBytes) await this.#scheduleEvict();
  }

  /**
   * Queue an eviction pass behind any already in flight.
   *
   * Coalescing concurrent callers onto a single in-flight pass looks like the
   * obvious optimisation but is wrong: a write that lands after that pass has
   * taken its size snapshot is never accounted for, so the cache settles above
   * the cap and stays there. Chaining gives every write its own pass, and a
   * pass that finds nothing to do returns immediately.
   */
  #scheduleEvict(): Promise<void> {
    this.#evicting = this.#evicting.then(() => this.#evict()).catch(() => undefined);
    return this.#evicting;
  }

  /** Drop oldest entries until we are back under 90% of the cap. */
  async #evict(): Promise<void> {
    const target = this.#maxBytes * 0.9;
    if (this.#totalBytes <= target) return;

    const byAge = [...this.#index.values()].sort((a, b) => a.lastAccess - b.lastAccess);

    for (const entry of byAge) {
      if (this.#totalBytes <= target) break;
      try {
        await fs.unlink(this.#pathFor(entry.key));
      } catch {
        // Already gone; still drop it from the index.
      }
      this.#index.delete(entry.key);
      this.#totalBytes -= entry.bytes;
    }
  }

  /** Exposed for tests and the health endpoint. */
  async clear(): Promise<void> {
    await fs.rm(this.#dir, { recursive: true, force: true });
    this.#index.clear();
    this.#totalBytes = 0;
    await fs.mkdir(this.#dir, { recursive: true });
  }
}
