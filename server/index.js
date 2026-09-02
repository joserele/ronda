import 'dotenv/config';
import { app } from './app.js';
import { initStore } from './store.js';
import { config, isConfigured } from './config.js';

await initStore();

app.listen(config.port, () => {
  const where = config.baseUrl || config.fallbackBaseUrl;
  console.log(`♪ Ronda is running at ${where}`);
  if (!config.baseUrl) {
    console.log('  BASE_URL not set — using each request\'s own origin (tunnel-friendly).');
  }
  console.log(`  Spotify redirect URI: ${where}/auth/callback`);
  if (!isConfigured()) {
    console.warn(
      '⚠ SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set — Spotify login is disabled.\n' +
        '  Copy .env.example to .env and fill it in (see README.md).'
    );
  }
  if (!process.env.SESSION_SECRET) {
    console.warn('⚠ SESSION_SECRET is not set — using a random one; sessions reset on restart.');
  }
});
