/**
 * Expose the local Vite server to Telegram Mini Apps.
 *
 * Telegram cannot load http://localhost inside a Mini App, so we open a
 * Cloudflare quick tunnel and point the bot's menu button at it.
 *
 *   pnpm tunnel
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, 'apps/backend/.env');
if (existsSync(envFile)) loadEnvFile(envFile);

const token = process.env.TELEGRAM_BOT_TOKEN;
const origin = process.env.TUNNEL_ORIGIN ?? 'http://localhost:5173';

const cloudflared = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'cloudflared',
].find((p) => p === 'cloudflared' || existsSync(p));

if (!cloudflared) {
  console.error('cloudflared is not installed. Install Cloudflare.cloudflared via winget.');
  process.exit(1);
}

async function setBotMenu(url) {
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN missing — tunnel is up, but the bot menu was not updated.');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      menu_button: { type: 'web_app', text: 'Open', web_app: { url } },
    }),
  });
  const body = await res.json();
  if (!body.ok) {
    console.warn('setChatMenuButton failed:', body.description);
    return;
  }
  console.log('Bot menu button Open →', url);
}

const child = spawn(cloudflared, ['tunnel', '--url', origin], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let announced = false;
const onChunk = (buf) => {
  const text = buf.toString();
  process.stderr.write(text);
  if (announced) return;
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  announced = true;
  const url = match[0];
  console.log('\nTelegram Mini App URL:', url);
  console.log('Local browser (no Telegram): http://localhost:5173/\n');
  void setBotMenu(url);
};

child.stdout.on('data', onChunk);
child.stderr.on('data', onChunk);
child.on('exit', (code) => process.exit(code ?? 1));
