import {
  LinearFilter,
  ClampToEdgeWrapping,
  SRGBColorSpace,
  Texture,
  type WebGLRenderer,
} from 'three';

/**
 * The single owner of every GPU texture in the reader.
 *
 * Components never construct a `Texture`; they call {@link acquire} and get a
 * handle back. That indirection is what makes the memory budget enforceable
 * rather than aspirational: there is exactly one place that allocates, one
 * that frees, and a counter that a test can assert on.
 *
 * Budget rationale. A `screen` page is 1080x1620 RGBA, which is
 * 1080 x 1620 x 4 = 6.99 MB on the GPU. Three of them (previous, current,
 * next) is about 21 MB, which every mobile WebView handles comfortably. The
 * same three at `zoom` resolution (2160x3240) would be 84 MB, which is around
 * where iOS starts dropping WebGL contexts under pressure. So the cap is
 * tiered: at most three screen-resolution pages, plus at most one zoom-
 * resolution page for whatever is under a pinch, released as soon as the
 * pinch ends.
 *
 * Mipmaps are disabled deliberately. They add 33% to every texture and buy
 * nothing here, because a page is displayed at roughly 1:1 and only ever
 * shrinks slightly mid-curl. `LinearFilter` for both min and mag keeps that
 * legal (a mipmap-based minFilter on a texture with no mipmaps renders black).
 */

export type TextureVariant = 'screen' | 'zoom';

/** Where the bytes for a page come from. Kept so we can re-decode after context loss. */
export type TextureSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'blob'; readonly blob: Blob };

interface Slot {
  readonly key: string;
  readonly source: TextureSource;
  readonly variant: TextureVariant;
  texture: Texture;
  /** Monotonic counter, not a clock: two acquires in the same ms must still order. */
  lastUsed: number;
  /** Bytes on the GPU, for the budget readout. */
  bytes: number;
}

export interface TextureStats {
  readonly screenCount: number;
  readonly zoomCount: number;
  readonly totalBytes: number;
  readonly pendingLoads: number;
  /** Cumulative evictions, for leak diagnosis in tests. */
  readonly evictions: number;
}

export interface TextureManagerOptions {
  /** Hard cap on simultaneous screen-resolution textures. */
  readonly screenCap?: number;
  /** Hard cap on simultaneous zoom-resolution textures. */
  readonly zoomCap?: number;
}

export class TextureManager {
  readonly #slots = new Map<string, Slot>();
  readonly #pending = new Map<string, { promise: Promise<Texture | null>; abort: AbortController }>();
  readonly #screenCap: number;
  readonly #zoomCap: number;

  #renderer: WebGLRenderer | null = null;
  #clock = 0;
  #evictions = 0;
  #disposed = false;

  constructor(options: TextureManagerOptions = {}) {
    this.#screenCap = options.screenCap ?? 3;
    this.#zoomCap = options.zoomCap ?? 1;
  }

  /**
   * Hand the manager the renderer so it can force texture uploads.
   *
   * Without a renderer we cannot call `initTexture`, so bitmaps would have to
   * be held until the first frame draws them. With it, upload happens on
   * acquire and the CPU-side bitmap is released immediately, which roughly
   * halves peak memory during a turn.
   */
  attachRenderer(renderer: WebGLRenderer): void {
    this.#renderer = renderer;
  }

  static keyFor(pageId: string, variant: TextureVariant): string {
    return `${variant}:${pageId}`;
  }

  /**
   * Get a texture for a page, decoding it if necessary.
   *
   * Returns `null` when the load was superseded or the manager was disposed
   * mid-flight, which callers must treat as "this page is no longer wanted"
   * rather than as an error.
   */
  async acquire(
    pageId: string,
    source: TextureSource,
    variant: TextureVariant = 'screen',
  ): Promise<Texture | null> {
    if (this.#disposed) return null;

    const key = TextureManager.keyFor(pageId, variant);

    const existing = this.#slots.get(key);
    if (existing) {
      existing.lastUsed = ++this.#clock;
      return existing.texture;
    }

    // Coalesce concurrent requests for the same page. The reader prefetches
    // neighbours while the user may also tap straight to one of them.
    const inFlight = this.#pending.get(key);
    if (inFlight) return inFlight.promise;

    const abort = new AbortController();
    const promise = this.#load(key, pageId, source, variant, abort.signal).finally(() => {
      this.#pending.delete(key);
    });
    this.#pending.set(key, { promise, abort });
    return promise;
  }

  async #load(
    key: string,
    _pageId: string,
    source: TextureSource,
    variant: TextureVariant,
    signal: AbortSignal,
  ): Promise<Texture | null> {
    let bitmap: ImageBitmap | null = null;

    try {
      const blob =
        source.kind === 'blob'
          ? source.blob
          : await fetch(source.url, { signal }).then((res) => {
              if (!res.ok) throw new Error(`image request failed: ${res.status}`);
              return res.blob();
            });

      if (signal.aborted || this.#disposed) return null;

      // Decoding on a worker thread is the difference between a dropped frame
      // and a smooth turn: a 1080p JPEG takes 15-30 ms to decode, which is two
      // frames at 60 Hz if it happens on the main thread.
      //
      // WebGL ignores UNPACK_FLIP_Y_WEBGL for ImageBitmap, so texture.flipY has
      // no effect. Flip at bitmap creation instead (Three.js ImageBitmapLoader
      // contract), otherwise every page renders upside-down.
      bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
        imageOrientation: 'flipY',
      });

      if (signal.aborted || this.#disposed) {
        bitmap.close();
        return null;
      }

      const texture = new Texture(bitmap);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.flipY = false;
      texture.needsUpdate = true;

      // Measured before closing: a closed ImageBitmap reports width and height
      // of zero, so reading the dimensions afterwards silently yields 0 bytes
      // and the whole budget readout becomes meaningless.
      const bytes = estimateBytes(bitmap.width, bitmap.height);

      // Force the upload now so the bitmap can be freed. Without this the
      // upload is deferred to the first draw, and we would have to keep the
      // bitmap alive until then, doubling peak memory for every page.
      this.#renderer?.initTexture(texture);
      bitmap.close();
      bitmap = null;

      this.#slots.set(key, {
        key,
        source,
        variant,
        texture,
        lastUsed: ++this.#clock,
        bytes,
      });

      // Evict *after* inserting so the page just requested is never the victim.
      this.#evictBeyondCap(variant);

      return texture;
    } catch (err) {
      bitmap?.close();
      if (signal.aborted) return null;
      // A failed page must not take the reader down; the caller renders a
      // placeholder and the user can retry by turning back and forth.
      console.warn(`[TextureManager] could not load ${key}:`, err);
      return null;
    }
  }

  /**
   * Drop least-recently-used textures until the variant is back within budget.
   *
   * Only the requested variant is considered, so a zoom allocation never
   * evicts the three screen pages the flip animation is mid-way through using.
   */
  #evictBeyondCap(variant: TextureVariant): void {
    const cap = variant === 'zoom' ? this.#zoomCap : this.#screenCap;

    const ofVariant = [...this.#slots.values()]
      .filter((s) => s.variant === variant)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    let excess = ofVariant.length - cap;
    for (const slot of ofVariant) {
      if (excess <= 0) break;
      this.#release(slot.key);
      excess--;
    }
  }

  #release(key: string): void {
    const slot = this.#slots.get(key);
    if (!slot) return;

    // `dispose()` queues the GL delete; three frees it on the next render.
    slot.texture.dispose();
    // Null the image reference too. three keeps `texture.image` alive
    // otherwise, and for a closed ImageBitmap that is a small but real leak
    // of the wrapper object across a long reading session.
    slot.texture.image = null;

    this.#slots.delete(key);
    this.#evictions++;
  }

  /** Explicitly drop a page, e.g. when leaving zoom. */
  release(pageId: string, variant: TextureVariant = 'screen'): void {
    this.#release(TextureManager.keyFor(pageId, variant));
  }

  /** Drop every zoom-resolution texture. Called when a pinch ends. */
  releaseZoom(): void {
    for (const slot of [...this.#slots.values()]) {
      if (slot.variant === 'zoom') this.#release(slot.key);
    }
  }

  /**
   * Cancel any in-flight load not in `keep`.
   *
   * Turning pages quickly can leave several decodes racing for textures nobody
   * will look at; each one holds a bitmap while it runs.
   */
  cancelExcept(keep: ReadonlySet<string>): void {
    for (const [key, entry] of this.#pending) {
      const pageId = key.slice(key.indexOf(':') + 1);
      if (!keep.has(pageId)) {
        entry.abort.abort();
        this.#pending.delete(key);
      }
    }
  }

  /**
   * Re-upload every live texture after a GL context restore.
   *
   * The GPU-side objects are gone but our bitmaps were freed at upload time,
   * so there is nothing to re-upload from. Every slot is therefore dropped and
   * the caller re-acquires from source. Mobile WebViews lose the context under
   * memory pressure, and without this the reader stays black forever.
   */
  invalidateForContextRestore(): TextureSource[] {
    const sources = [...this.#slots.values()].map((s) => s.source);
    for (const key of [...this.#slots.keys()]) this.#release(key);
    return sources;
  }

  stats(): TextureStats {
    let screenCount = 0;
    let zoomCount = 0;
    let totalBytes = 0;
    for (const slot of this.#slots.values()) {
      if (slot.variant === 'zoom') zoomCount++;
      else screenCount++;
      totalBytes += slot.bytes;
    }
    return {
      screenCount,
      zoomCount,
      totalBytes,
      pendingLoads: this.#pending.size,
      evictions: this.#evictions,
    };
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Full teardown. Safe to call twice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const entry of this.#pending.values()) entry.abort.abort();
    this.#pending.clear();

    for (const key of [...this.#slots.keys()]) this.#release(key);
    this.#renderer = null;
  }
}

/** GPU footprint of a texture. Mipmaps are off, so this is just w x h x 4. */
function estimateBytes(width: number, height: number): number {
  if (!width || !height) return 0;
  return width * height * 4;
}
