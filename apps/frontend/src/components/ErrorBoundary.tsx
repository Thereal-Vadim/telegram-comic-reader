import { Component, type ErrorInfo, type ReactNode } from 'react';
import { bootError, getBootEntries } from '../boot/log';

/**
 * Last-resort boundary.
 *
 * The specific thing this guards against is a WebGL failure taking the whole
 * app down. If the reader throws because the device refused a context, the
 * catalog should still work, so the boundary offers a way back rather than
 * leaving a blank screen with no route out.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] uncaught error:', error, info.componentStack);
    bootError('crash', error.message);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stages = getBootEntries().slice(-10);

    return (
      <div className="flex min-h-viewport flex-col items-center justify-center gap-3 px-6 pb-safe text-center">
        <h1 className="text-base font-semibold text-tg-destructive">Something broke</h1>
        <p className="max-w-sm text-sm text-tg-hint">{error.message}</p>

        {stages.length > 0 && (
          <ol className="mt-2 w-full max-w-sm rounded-xl bg-tg-secondary-bg px-3 py-3 text-left font-mono text-[11px] leading-snug text-tg-hint">
            {stages.map((entry) => (
              <li key={entry.id}>
                <span className="font-semibold text-tg-text">{entry.stage}</span>
                {entry.detail ? ` — ${entry.detail}` : ''}
              </li>
            ))}
          </ol>
        )}

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-lg bg-tg-secondary-bg px-4 py-2 text-sm text-tg-text"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => {
              // Back to the catalog rather than a reload: if the reader is
              // what failed, reloading straight back into it just fails again.
              window.location.href = '/';
            }}
            className="rounded-lg bg-tg-button px-4 py-2 text-sm font-medium text-tg-button-text"
          >
            Back to library
          </button>
        </div>
      </div>
    );
  }
}
