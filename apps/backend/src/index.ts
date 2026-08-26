import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

/**
 * Process entrypoint. Kept separate from `buildServer` so tests can construct
 * an app instance without binding a port or installing signal handlers.
 */
async function main(): Promise<void> {
  const { app, cfg } = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      // Lets in-flight image transcodes finish rather than cutting responses.
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: cfg.host, port: cfg.port });
  } catch (err) {
    app.log.error({ err }, 'failed to bind');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Config errors happen before a logger exists, so this is the one raw write.
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
