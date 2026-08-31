import 'dotenv/config';
import { app } from './app.js';
import { initStore } from './store.js';
import { config, isConfigured } from './config.js';

await initStore();

app.listen(config.port, () => {
  console.log(`♪ Ronda is running at ${config.baseUrl}`);
  if (!isConfigured()) {
    console.warn(
      '⚠ SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set — Spotify login is disabled.\n' +
        '  Copy .env.example to .env and fill it in (see README.md).'
    );
  } else {
    console.log(`  Spotify redirect URI: ${config.redirectUri}`);
  }
  if (!process.env.SESSION_SECRET) {
    console.warn('⚠ SESSION_SECRET is not set — using a random one; sessions reset on restart.');
  }
});
