import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { bootError, bootOk, bootStage } from './boot/log';
import { initTelegram } from './telegram/webapp';
import { watchTelegramAppearance } from './telegram/theme';
import './styles.css';

bootStage('bundle', 'JavaScript module graph loaded');

window.addEventListener('error', (event) => {
  bootError('runtime', event.message || 'uncaught error');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  bootError(
    'runtime',
    reason instanceof Error ? reason.message : String(reason ?? 'unhandled rejection'),
  );
});

/*
 * Telegram is initialised before React mounts so the first paint already has
 * the right theme colours and viewport height. Doing it in an effect instead
 * produces a visible flash of the fallback palette on every cold start.
 */
try {
  bootStage('telegram', 'Initialising WebApp bridge');
  initTelegram();
  watchTelegramAppearance();
  bootOk('telegram', 'ready');
} catch (err) {
  bootError('telegram', err instanceof Error ? err.message : String(err));
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

bootStage('react', 'Mounting UI');
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
bootOk('react', 'mounted');
