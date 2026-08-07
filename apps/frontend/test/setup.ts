import { vi } from 'vitest';

/**
 * jsdom has neither `createImageBitmap` nor a GPU, so the pieces the
 * TextureManager leans on are stubbed here.
 *
 * The stub deliberately tracks `close()` calls. Whether a bitmap is closed is
 * the difference between a reader that holds steady over a few hundred pages
 * and one that accumulates a decoded copy of every page it has shown, and that
 * is not observable any other way from a test.
 */

export interface FakeBitmap extends ImageBitmap {
  closed: boolean;
}

/** Every bitmap handed out, so tests can assert none were leaked. */
export const createdBitmaps: FakeBitmap[] = [];

export function resetBitmaps(): void {
  createdBitmaps.length = 0;
}

const makeBitmap = (width = 1080, height = 1620): FakeBitmap => {
  const bitmap: FakeBitmap = {
    width,
    height,
    closed: false,
    close() {
      bitmap.closed = true;
    },
  };
  createdBitmaps.push(bitmap);
  return bitmap;
};

/**
 * (Re)install the decoding stub.
 *
 * Exported so a test that swaps in a failing decoder can hand the working one
 * back afterwards; without this, the next test silently runs against the
 * failure stub and its assertions become meaningless.
 */
export function installBitmapStub(): void {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => makeBitmap()));
}

installBitmapStub();

/*
 * A minimal response stub rather than a real `Response`. jsdom's Blob and
 * Node's undici Response come from different realms, and undici rejects the
 * jsdom Blob with "object.stream is not a function". The manager only ever
 * calls `ok` and `blob()`, so this is the whole surface that matters.
 */
vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
  })),
);

// matchMedia is consulted by the reduced-motion hook.
if (!window.matchMedia) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}
