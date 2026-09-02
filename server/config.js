import crypto from 'node:crypto';

const port = Number(process.env.PORT || 3000);

// BASE_URL is optional: when unset, each request's own origin is used (see
// origin.js), which keeps tunnels and PaaS hosts working without reconfiguring.
const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');

export const config = {
  port,
  baseUrl,
  fallbackBaseUrl: `http://127.0.0.1:${port}`,
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  // Without SESSION_SECRET sessions still work but reset on every restart.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  dataDir: process.env.DATA_DIR || 'data',
};

export const isConfigured = () => Boolean(config.clientId && config.clientSecret);
