import { describe, expect, it } from 'vitest';
import { ComxSession } from '../src/adapters/comxSession.js';

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
});
