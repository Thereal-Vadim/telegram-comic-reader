/**
 * Boot / load stage log for the Mini App shell.
 *
 * White screens in Telegram are hard to diagnose; this keeps a short,
 * user-visible trail of which stage we are on (and any failure), so a slow
 * com-x login is not indistinguishable from a crashed import.
 */

export type BootLevel = 'info' | 'ok' | 'warn' | 'error';

export interface BootEntry {
  readonly id: number;
  readonly at: number;
  readonly stage: string;
  readonly detail?: string;
  readonly level: BootLevel;
}

type Listener = (entries: readonly BootEntry[]) => void;

const MAX_ENTRIES = 40;
const entries: BootEntry[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  const snapshot = entries.slice();
  for (const listener of listeners) listener(snapshot);
  // Mirror to the console for remote WebView debugging.
  const last = snapshot[snapshot.length - 1];
  if (last) {
    const line = `[boot] ${last.stage}${last.detail ? ` — ${last.detail}` : ''}`;
    if (last.level === 'error') console.error(line);
    else if (last.level === 'warn') console.warn(line);
    else console.info(line);
  }
  // Keep a DOM hook for the pre-React splash in index.html.
  try {
    const el = document.getElementById('boot-splash-stage');
    if (el) {
      el.textContent = last
        ? `${last.stage}${last.detail ? `: ${last.detail}` : ''}`
        : 'Starting…';
    }
  } catch {
    // ignore
  }
}

export function bootStage(
  stage: string,
  detail?: string,
  level: BootLevel = 'info',
): void {
  entries.push({
    id: nextId++,
    at: Date.now(),
    stage,
    ...(detail !== undefined ? { detail } : {}),
    level,
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  emit();
}

export function bootOk(stage: string, detail?: string): void {
  bootStage(stage, detail, 'ok');
}

export function bootWarn(stage: string, detail?: string): void {
  bootStage(stage, detail, 'warn');
}

export function bootError(stage: string, detail?: string): void {
  bootStage(stage, detail, 'error');
}

export function getBootEntries(): readonly BootEntry[] {
  return entries;
}

export function subscribeBootLog(listener: Listener): () => void {
  listeners.add(listener);
  listener(entries.slice());
  return () => {
    listeners.delete(listener);
  };
}
