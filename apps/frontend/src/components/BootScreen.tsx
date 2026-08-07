import { useEffect, useState } from 'react';
import {
  getBootEntries,
  subscribeBootLog,
  type BootEntry,
  type BootLevel,
} from '../boot/log';

const LEVEL_CLASS: Record<BootLevel, string> = {
  info: 'text-tg-hint',
  ok: 'text-tg-link',
  warn: 'text-amber-400',
  error: 'text-tg-destructive',
};

/**
 * Full-screen boot/load status with a live stage log.
 * Shown instead of a blank white WebView while auth, IndexedDB, or home feed run.
 */
export function BootScreen({
  title = 'Loading',
  subtitle,
}: {
  title?: string;
  subtitle?: string;
}): React.JSX.Element {
  const [entries, setEntries] = useState<readonly BootEntry[]>(() => getBootEntries());

  useEffect(() => subscribeBootLog(setEntries), []);

  const latest = entries[entries.length - 1];
  const recent = entries.slice(-8);

  return (
    <div className="flex min-h-viewport flex-col bg-tg-bg px-5 pb-safe pt-10 text-tg-text">
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div
          className="h-9 w-9 animate-spin rounded-full border-2 border-tg-hint border-t-tg-button"
          role="status"
          aria-label={title}
        />
        <div className="text-center">
          <h1 className="text-base font-semibold">{title}</h1>
          <p className="mt-1 max-w-xs text-sm text-tg-hint">
            {subtitle ?? (latest ? `${latest.stage}${latest.detail ? ` — ${latest.detail}` : ''}` : 'Starting…')}
          </p>
        </div>
      </div>

      <section
        className="mb-6 rounded-xl bg-tg-secondary-bg px-3 py-3"
        aria-label="Load stages"
      >
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-tg-subtitle">
          Stages
        </h2>
        <ol className="max-h-48 space-y-1.5 overflow-y-auto font-mono text-[11px] leading-snug">
          {recent.length === 0 ? (
            <li className="text-tg-hint">Waiting for first stage…</li>
          ) : (
            recent.map((entry) => (
              <li key={entry.id} className={LEVEL_CLASS[entry.level]}>
                <span className="text-tg-subtitle">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>{' '}
                <span className="font-semibold">{entry.stage}</span>
                {entry.detail ? <span className="text-tg-hint"> — {entry.detail}</span> : null}
              </li>
            ))
          )}
        </ol>
      </section>
    </div>
  );
}
