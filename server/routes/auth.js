import crypto from 'node:crypto';
import { Router } from 'express';
import { isConfigured } from '../config.js';
import { redirectUriFor } from '../origin.js';
import {
  sign,
  unsign,
  parseCookies,
  setCookie,
  writeSession,
  clearSession,
} from '../session.js';
import { authorizeUrl, exchangeCode, getProfile } from '../spotify.js';
import * as store from '../store.js';
import { clearCachesForUser } from './api.js';

const OAUTH_COOKIE = 'ronda_oauth';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export const authRouter = Router();

/**
 * Start the Spotify login.
 *   ?next=/some/path  → where to land afterwards (same-site paths only)
 *   ?join=<roomId>    → auto-join that room after logging in
 *   ?invite=<code>    → the invite that authorises that join
 */
authRouter.get('/auth/login', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).send(setupHelpHtml(redirectUriFor(req)));
  }
  const nonce = crypto.randomBytes(16).toString('base64url');
  const join = typeof req.query.join === 'string' ? req.query.join.slice(0, 64) : '';
  const invite = typeof req.query.invite === 'string' ? req.query.invite.slice(0, 64) : '';
  let next = typeof req.query.next === 'string' ? req.query.next : '';
  if (!/^\/(?!\/)/.test(next)) next = ''; // same-site relative paths only

  const payload = Buffer.from(JSON.stringify({ n: nonce, join, invite, next, t: Date.now() })).toString(
    'base64url'
  );
  setCookie(req, res, OAUTH_COOKIE, sign(nonce), 600);
  res.redirect(authorizeUrl(sign(payload), redirectUriFor(req)));
});

authRouter.get('/auth/callback', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  setCookie(req, res, OAUTH_COOKIE, '', 0);

  if (req.query.error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(String(req.query.error))}`);
  }

  // Validate the state we sent: signed by us, fresh, and bound to this browser.
  let statePayload = null;
  const stateRaw = unsign(String(req.query.state || ''));
  const cookieNonce = unsign(cookies[OAUTH_COOKIE] || '');
  if (stateRaw && cookieNonce) {
    try {
      const parsed = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
      if (parsed.n === cookieNonce && Date.now() - parsed.t < STATE_MAX_AGE_MS) {
        statePayload = parsed;
      }
    } catch {
      // fall through to state_mismatch
    }
  }
  if (!statePayload || typeof req.query.code !== 'string') {
    return res.redirect('/?auth_error=state_mismatch');
  }

  try {
    const tokens = await exchangeCode(req.query.code, redirectUriFor(req));
    const profile = await getProfile(tokens.accessToken);
    const user = store.upsertUser({
      spotifyId: profile.id,
      displayName: profile.display_name || profile.id,
      avatarUrl: profile.images?.[0]?.url ?? null,
      tokens,
    });
    writeSession(req, res, { uid: user.uid, iat: Date.now() });

    let dest = statePayload.next || '/';
    const room = statePayload.join ? store.getRoom(statePayload.join) : null;
    if (room) {
      // Only a valid invite gets them in; a stale one still lands them on the
      // room page, which explains why they can't join.
      if (room.memberUids.includes(user.uid) || store.inviteMatches(room, statePayload.invite)) {
        store.joinRoom(room.id, user.uid);
      }
      const query = statePayload.invite
        ? `?invite=${encodeURIComponent(statePayload.invite)}`
        : '';
      dest = `/r/${room.id}${query}`;
    }
    clearCachesForUser(user.uid); // after any join, so the new room is included
    res.redirect(dest);
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.redirect('/?auth_error=login_failed');
  }
});

authRouter.post('/auth/logout', (req, res) => {
  clearSession(req, res);
  res.status(204).end();
});

const setupHelpHtml = (redirectUri) => `<!doctype html>
<meta charset="utf-8">
<title>Ronda — setup needed</title>
<body style="font-family:system-ui,sans-serif;background:#0d0f14;color:#eceef3;display:grid;place-items:center;min-height:100vh;margin:0">
  <div style="max-width:560px;padding:32px;line-height:1.65">
    <h1 style="margin-top:0">Almost there 🎧</h1>
    <p>Spotify credentials aren't configured yet. Copy <code>.env.example</code> to <code>.env</code>,
    fill in <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> from your
    <a style="color:#ff6f61" href="https://developer.spotify.com/dashboard">Spotify developer app</a>,
    then restart the server. The app's Redirect URI must be
    <code>${redirectUri}</code>.</p>
    <p><a style="color:#ff6f61" href="/">&larr; Back to Ronda</a></p>
  </div>`;
