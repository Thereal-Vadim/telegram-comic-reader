import fs from 'node:fs/promises';
import sharp from 'sharp';
import { AppError, VARIANT_WIDTH, type ImageVariant } from '@comic/shared';
import type { ImageSource } from '../adapters/types.js';
import { readZipEntry } from '../adapters/zip.js';
import { resolveSafeTarget, safeFetch, type GuardOptions } from '../net/ssrf.js';
import { ImageCache } from './cache.js';

/**
 * Turns an {@link ImageSource} into cached WebP bytes at a requested variant.
 *
 * Everything the reader displays goes through here, which is what makes the
 * CORS story work: the Mini App only ever loads images from its own API origin,
 * never from a third-party host, so the Telegram WebView has nothing to block.
 */

export interface TranscodeResult {
  readonly body: Buffer;
  /** Strong validator for conditional requests. */
  readonly etag: string;
  readonly fromCache: boolean;
}

export interface PipelineDeps {
  readonly cache: ImageCache;
  readonly quality: number;
  readonly maxSourceBytes: number;
  readonly guard: GuardOptions;
}

/** Read the raw bytes behind a source, whatever kind it is. */
async function readSource(
  source: ImageSource,
  deps: PipelineDeps,
  resolveFilePath: (relOrAbs: string) => string,
): Promise<Buffer> {
  switch (source.kind) {
    case 'file': {
      const abs = resolveFilePath(source.path);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) throw new AppError('NOT_FOUND', 'image file does not exist');
      if (st.size > deps.maxSourceBytes) {
        throw new AppError('UPSTREAM_MALFORMED', 'source image exceeds the size limit');
      }
      return fs.readFile(abs);
    }

    case 'zip-entry': {
      const abs = resolveFilePath(source.archivePath);
      return readZipEntry(abs, source.entryName, deps.maxSourceBytes);
    }

    case 'http': {
      // Re-validated here rather than trusting the adapter that produced it.
      const target = await resolveSafeTarget(source.url, deps.guard);
      const { body } = await safeFetch(target, {
        headers: source.headers ?? {},
        timeoutMs: 15_000,
        maxBytes: deps.maxSourceBytes,
      });
      return body;
    }
  }
}

/**
 * Decode, resize and re-encode to WebP.
 *
 * Notable choices:
 *  - `withoutEnlargement` so a page smaller than the target width is never
 *    upscaled; upscaling costs bytes and GPU memory and adds no detail.
 *  - `rotate()` with no argument applies the EXIF orientation and strips it.
 *    Without this, a phone-scanned page renders sideways in WebGL, because a
 *    texture upload ignores EXIF entirely.
 *  - Metadata is dropped, which removes any embedded colour profile and, more
 *    to the point, any GPS or camera fields in scanned material.
 */
async function transcode(input: Buffer, variant: ImageVariant, quality: number): Promise<Buffer> {
  const width = VARIANT_WIDTH[variant];

  try {
    const pipeline = sharp(input, {
      // Bounded input protects against decompression bombs disguised as pages.
      limitInputPixels: 40_000 * 40_000,
      failOn: 'error',
    })
      .rotate()
      .resize({ width, withoutEnlargement: true, fit: 'inside' })
      .webp({ quality, effort: 4 });

    return await pipeline.toBuffer();
  } catch (err) {
    throw new AppError('TRANSCODE_FAILED', `could not process image: ${String(err)}`);
  }
}

export async function getTranscodedImage(
  source: ImageSource,
  variant: ImageVariant,
  sourceRef: string,
  deps: PipelineDeps,
  resolveFilePath: (relOrAbs: string) => string,
): Promise<TranscodeResult> {
  const key = ImageCache.key(sourceRef, variant, deps.quality);
  const etag = `"${key.slice(0, 32)}"`;

  const cached = await deps.cache.get(key);
  if (cached) return { body: cached, etag, fromCache: true };

  const raw = await readSource(source, deps, resolveFilePath);
  const out = await transcode(raw, variant, deps.quality);

  // Cache write is intentionally not awaited for correctness, only for
  // backpressure: a slow disk should not stall the response.
  await deps.cache.set(key, out);

  return { body: out, etag, fromCache: false };
}
