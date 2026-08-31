// Minimal stateless sessions: an HMAC-signed cookie carrying { uid }.
// No server-side session storage needed, no extra dependencies.
import crypto from 'node:crypto';
import { config } from './config.js';

const SESSION_COOKIE = 'ronda_session';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function hmac(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

export function sign(value) {
  return `${value}.${hmac(value)}`;
}

export function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const mac = Buffer.from(signed.slice(i + 1));
  const expected = Buffer.from(hmac(value));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  return value;
}

export function parseCookies(header = '') {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ignore malformed cookie values
    }
  }
  return out;
}

export function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.isSecure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const existing = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...existing, parts.join('; ')]);
}

export function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const value = unsign(raw);
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function writeSession(res, data) {
  const value = Buffer.from(JSON.stringify(data)).toString('base64url');
  setCookie(res, SESSION_COOKIE, sign(value), SESSION_MAX_AGE_S);
}

export function clearSession(res) {
  setCookie(res, SESSION_COOKIE, '', 0);
}
