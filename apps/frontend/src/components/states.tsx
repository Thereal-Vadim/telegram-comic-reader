import type { ReactNode } from 'react';
import { ApiClientError } from '../api/client';

/**
 * Shared loading, empty, and error presentation.
 *
 * The error view is the interesting one: it maps each failure code to advice
 * the user can act on. A reader that says "something went wrong" for both a
 * dropped connection and an unconfigured backend teaches the user to ignore
 * errors, so each case says what actually happened and what to do.
 */

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12" role="status">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-tg-hint border-t-tg-button" />
      {label && <p className="text-sm text-tg-hint">{label}</p>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <h3 className="text-base font-semibold text-tg-text">{title}</h3>
      {description && <p className="max-w-sm text-sm text-tg-hint">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

interface ErrorAdvice {
  title: string;
  description: string;
  canRetry: boolean;
}

/** Turn a thrown value into something worth showing a person. */
export function describeError(error: unknown): ErrorAdvice {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'OFFLINE':
        return {
          title: 'You are offline',
          description:
            'Downloaded chapters are still available. Connect to load anything new.',
          canRetry: true,
        };
      case 'NETWORK':
        return {
          title: 'Could not reach the server',
          description: 'The connection dropped or the backend is not running.',
          canRetry: true,
        };
      case 'UNAUTHORIZED':
        return {
          title: 'Session expired',
          description: 'Close and reopen the app from Telegram to sign in again.',
          canRetry: false,
        };
      case 'RATE_LIMITED':
        return {
          title: 'Too many requests',
          description: 'Give it a moment before trying again.',
          canRetry: true,
        };
      case 'UPSTREAM_UNAVAILABLE':
        return {
          title: 'Content source is unreachable',
          description: 'Your library server did not respond. Check that it is running.',
          canRetry: true,
        };
      case 'UPSTREAM_MALFORMED':
        return {
          title: 'Could not read this content',
          description: error.message,
          canRetry: false,
        };
      case 'ORIGIN_NOT_ALLOWED':
        return {
          title: 'Blocked by the proxy',
          description:
            'That image host is not on the allowlist. Add it to PROXY_EXTRA_HOSTS on the server.',
          canRetry: false,
        };
      case 'TRANSCODE_FAILED':
        return {
          title: 'This page could not be processed',
          description: 'The image is corrupt or in a format the server cannot decode.',
          canRetry: false,
        };
      case 'NOT_FOUND':
        return {
          title: 'Not found',
          description: 'This item is no longer in the library.',
          canRetry: false,
        };
      case 'INTERNAL':
        return {
          title: 'Server error',
          description: error.message,
          canRetry: true,
        };
      default:
        return { title: 'Something went wrong', description: error.message, canRetry: true };
    }
  }

  if (error instanceof Error) {
    return { title: 'Something went wrong', description: error.message, canRetry: true };
  }
  return { title: 'Something went wrong', description: String(error), canRetry: true };
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): React.JSX.Element {
  const advice = describeError(error);

  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <h3 className="text-base font-semibold text-tg-destructive">{advice.title}</h3>
      <p className="max-w-sm text-sm text-tg-hint">{advice.description}</p>
      {advice.canRetry && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg bg-tg-button px-5 py-2 text-sm font-medium text-tg-button-text active:opacity-80"
        >
          Try again
        </button>
      )}
    </div>
  );
}
