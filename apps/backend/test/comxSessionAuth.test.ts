import { describe, expect, it } from 'vitest';
import { ComxSession, isLoginWallHtml } from '../src/adapters/comxSession.js';

describe('ComxSession auth surface for catalog + downloads', () => {
  it('exposes browser headers without Cookie before login', () => {
    const session = new ComxSession(
      { allowedHosts: new Set(['com-x.life']), allowPrivate: false },
      { maxBytes: 1024, downloadMaxBytes: 2048 },
    );

    session.setCredentials({ login: 'reader', password: 'secret' });
    expect(session.status()).toEqual({
      connected: false,
      login: 'reader',
      cookieCount: 0,
    });

    const headers = session.authHeaders({ accept: 'image/*' });
    expect(headers['user-agent']).toMatch(/Chrome/);
    expect(headers.accept).toBe('image/*');
    expect(headers.cookie).toBeUndefined();
  });

  it('keeps download() as the large-binary path on the same session', () => {
    const session = new ComxSession(
      { allowedHosts: new Set(['com-x.life']), allowPrivate: false },
      { maxBytes: 1000, downloadMaxBytes: 5000 },
    );
    expect(typeof session.download).toBe('function');
    expect(typeof session.fetch).toBe('function');
    expect(typeof session.ensureAuthenticated).toBe('function');
  });

  it('does not treat a public catalog page with a login modal as a gate', () => {
    const html = `
      <html><title>Читать комиксы</title>
      <input name="login_name" /><input name="login_password" />
      <div class="sandev-auth-magic"></div>
      <a class="poster" href="/1-x.html"><p class="poster__title">X</p></a>
      </html>`;
    expect(isLoginWallHtml(html)).toBe(false);
  });

  it('still detects a dedicated login gate with no catalog cards', () => {
    const html = `
      <html><title>Com-X.life — вход</title>
      <input name="login_name" /><input name="login_password" />
      <div class="sandev-auth-magic"></div>
      </html>`;
    expect(isLoginWallHtml(html)).toBe(true);
  });
});
