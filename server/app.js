import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { SpotifyError } from './spotify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Cookies are SameSite=Lax; this adds a same-origin check on top for writes.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== config.baseUrl) {
    return res.status(403).json({ error: 'bad_origin' });
  }
  next();
});

app.use(authRouter);
app.use(apiRouter);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Room pages are a single static page that loads its data client-side.
app.get('/r/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'room.html')));

app.use(express.static(PUBLIC_DIR));

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (err instanceof SpotifyError) {
    return res.status(502).json({
      error: 'spotify_error',
      message: `Spotify said no: ${err.message}`,
    });
  }
  const status = err.status === 400 || err.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: 'server_error', message: 'Something went wrong.' });
});
