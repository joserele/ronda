// Where the browser thinks this server lives.
//
// Locally that's http://127.0.0.1:3000, but behind a tunnel (ngrok, Cloudflare)
// or a host like Render it's a public HTTPS URL that can change on every
// restart. Rather than force BASE_URL to be re-edited each time, we derive the
// origin from the request itself and only fall back to BASE_URL when it's set.
//
// Safety note: this trusts the Host / X-Forwarded-* headers. A spoofed Host
// can't be used to steal a Spotify login, because Spotify only redirects to
// redirect URIs pre-registered on the app. Set BASE_URL in production to pin
// the origin and skip the header entirely.
import { config } from './config.js';

const VALID_HOST = /^[A-Za-z0-9._~-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/** Proxies may append to these headers ("https,http") — the client-most value is first. */
function firstValue(header) {
  if (!header) return '';
  return String(Array.isArray(header) ? header[0] : header).split(',')[0].trim();
}

export function publicOrigin(req) {
  if (config.baseUrl) return config.baseUrl; // explicitly configured wins

  const host = firstValue(req.headers['x-forwarded-host']) || firstValue(req.headers.host);
  if (!host || !VALID_HOST.test(host)) return config.fallbackBaseUrl;

  const proto =
    firstValue(req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export const redirectUriFor = (req) => `${publicOrigin(req)}/auth/callback`;

export const isSecureOrigin = (origin) => origin.startsWith('https://');
