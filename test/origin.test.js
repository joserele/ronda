import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicOrigin, redirectUriFor } from '../server/origin.js';
import { config } from '../server/config.js';

const req = (headers = {}) => ({ headers, socket: {} });

test('derives the origin from the Host header when BASE_URL is unset', () => {
  assert.equal(publicOrigin(req({ host: '127.0.0.1:3000' })), 'http://127.0.0.1:3000');
});

test('honours a tunnel/proxy forwarding HTTPS', () => {
  const r = req({ host: 'internal:3000', 'x-forwarded-host': 'abc123.ngrok-free.app', 'x-forwarded-proto': 'https' });
  assert.equal(publicOrigin(r), 'https://abc123.ngrok-free.app');
  assert.equal(redirectUriFor(r), 'https://abc123.ngrok-free.app/auth/callback');
});

test('takes the client-most value from a comma-joined proxy chain', () => {
  const r = req({ 'x-forwarded-host': 'public.example, internal', 'x-forwarded-proto': 'https,http' });
  assert.equal(publicOrigin(r), 'https://public.example');
});

test('falls back when the Host header is missing or malformed', () => {
  assert.equal(publicOrigin(req()), config.fallbackBaseUrl);
  assert.equal(publicOrigin(req({ host: 'evil.example/path' })), config.fallbackBaseUrl);
  assert.equal(publicOrigin(req({ host: 'bad host' })), config.fallbackBaseUrl);
});

test('an explicit BASE_URL always wins over request headers', () => {
  const saved = config.baseUrl;
  config.baseUrl = 'https://ronda.example';
  try {
    assert.equal(publicOrigin(req({ host: 'someone-else.example' })), 'https://ronda.example');
  } finally {
    config.baseUrl = saved;
  }
});
