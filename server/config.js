import crypto from 'node:crypto';

const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  baseUrl,
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  // Without SESSION_SECRET sessions still work but reset on every restart.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  dataDir: process.env.DATA_DIR || 'data',
  redirectUri: `${baseUrl}/auth/callback`,
  isSecure: baseUrl.startsWith('https://'),
};

export const isConfigured = () => Boolean(config.clientId && config.clientSecret);
