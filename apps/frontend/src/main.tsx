import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initTelegram } from './telegram/webapp';
import { watchTelegramAppearance } from './telegram/theme';
import './styles.css';

/*
 * Telegram is initialised before React mounts so the first paint already has
 * the right theme colours and viewport height. Doing it in an effect instead
 * produces a visible flash of the fallback palette on every cold start.
 */
initTelegram();
watchTelegramAppearance();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
