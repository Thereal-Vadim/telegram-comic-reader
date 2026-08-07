/**
 * Limits how many chapter-preview requests run at once.
 * The issue grid can expose dozens of cells at once; without a queue they
 * stampede the API (and the upstream site) and trip the rate limiter before
 * the user even taps Read.
 */

type Task<T> = () => Promise<T>;

const MAX_CONCURRENT = 3;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

export async function enqueuePreview<T>(task: Task<T>): Promise<T> {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}
