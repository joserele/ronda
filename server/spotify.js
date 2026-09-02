// Thin Spotify Web API client: OAuth (authorization code flow), automatic
// token refresh, and just the endpoints Ronda needs.
import { config } from './config.js';
import * as store from './store.js';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

// Minimal scopes: read each member's listening history and their most-played
// tracks, and create playlists.
export const SCOPES = [
  'user-read-recently-played',
  'user-top-read',
  'playlist-modify-public',
  'playlist-modify-private',
];

/**
 * Spotify's answer when a token was minted before we started asking for a
 * scope. Refreshing can't widen a token, so the user has to authorize again.
 */
export const isMissingScope = (err) =>
  err instanceof SpotifyError &&
  err.status === 403 &&
  /insufficient.*scope/i.test(err.message ?? '');

export class SpotifyError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
    this.body = body;
  }
}

// ---- OAuth ------------------------------------------------------------

export function authorizeUrl(state, redirectUri) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
    show_dialog: 'false',
  });
  return `${ACCOUNTS_BASE}/authorize?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SpotifyError(
      body.error_description || body.error || `Token request failed (${res.status})`,
      res.status,
      body
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token, // absent on refresh unless rotated
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

// Spotify requires the same redirect_uri used to obtain the code.
export const exchangeCode = (code, redirectUri) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });

export const refreshAccessToken = (refreshToken) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

async function freshAccessToken(user) {
  const tokens = user.tokens ?? {};
  if (tokens.accessToken && Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
  try {
    const next = await refreshAccessToken(tokens.refreshToken);
    store.updateUserTokens(user.uid, {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken || tokens.refreshToken,
      expiresAt: next.expiresAt,
    });
    return next.accessToken;
  } catch (err) {
    // invalid_grant means the user revoked access — they need to log in again.
    if (err instanceof SpotifyError && err.status === 400) {
      store.setNeedsReconnect(user.uid, true);
    }
    throw err;
  }
}

// ---- API calls --------------------------------------------------------

async function rawApi(accessToken, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new SpotifyError(
      data?.error?.message || `Spotify API error (${res.status})`,
      res.status,
      data
    );
    err.retryAfter = Number(res.headers.get('retry-after')) || null;
    throw err;
  }
  return data;
}

async function api(user, method, path, body) {
  try {
    return await callApi(user, method, path, body);
  } catch (err) {
    if (isMissingScope(err)) store.setNeedsReconnect(user.uid, true);
    throw err;
  }
}

async function callApi(user, method, path, body) {
  const attempt = async () => rawApi(await freshAccessToken(user), method, path, body);
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 401) {
      // Access token rejected early — force a refresh and retry once.
      if (user.tokens) user.tokens.expiresAt = 0;
      return attempt();
    }
    if (err instanceof SpotifyError && err.status === 429 && err.retryAfter && err.retryAfter <= 5) {
      await new Promise((resolve) => setTimeout(resolve, err.retryAfter * 1000));
      return attempt();
    }
    throw err;
  }
}

/** Profile of whoever owns the given access token (used during login). */
export const getProfile = (accessToken) => rawApi(accessToken, 'GET', '/me');

function pickImage(images) {
  if (!images?.length) return null;
  // Images come largest-first; the middle one (~300px) is plenty for the UI.
  return (images[1] ?? images[0]).url;
}

/** Playable tracks only — skips podcast episodes and local files, which have no shareable URI. */
function mapTrack(track) {
  if (!track || track.type !== 'track' || track.is_local || !track.uri) return null;
  return {
    uri: track.uri,
    id: track.id,
    name: track.name,
    artists: (track.artists ?? []).map((a) => a.name).join(', '),
    image: pickImage(track.album?.images),
  };
}

/** Most recent plays for a user, newest first, deduplicated by the API's order. */
export async function getRecentlyPlayed(user, limit = 50) {
  const data = await api(user, 'GET', `/me/player/recently-played?limit=${Math.min(limit, 50)}`);
  const items = [];
  for (const it of data?.items ?? []) {
    const track = mapTrack(it?.track);
    if (track) items.push({ ...track, playedAt: it.played_at });
  }
  return items;
}

const TOP_PAGE_SIZE = 50; // the endpoint's per-request maximum

/**
 * A user's most-played tracks, ranked highest-first. `timeRange` is Spotify's
 * own window: short_term ≈ last 4 weeks, medium_term ≈ 6 months, long_term ≈ years.
 * Needs the `user-top-read` scope.
 */
export async function getTopTracks(user, limit = 50, timeRange = 'short_term') {
  const items = [];
  for (let offset = 0; items.length < limit; offset += TOP_PAGE_SIZE) {
    const page = Math.min(TOP_PAGE_SIZE, limit - items.length);
    const data = await api(
      user,
      'GET',
      `/me/top/tracks?time_range=${timeRange}&limit=${page}&offset=${offset}`
    );
    const batch = data?.items ?? [];
    for (const raw of batch) {
      const track = mapTrack(raw);
      if (track) items.push({ ...track, rank: items.length + 1 });
    }
    if (batch.length < page) break; // the user has no more ranked tracks
  }
  return items;
}

// Spotify's 2026 Web API migration retired the endpoints this used to call:
// POST /users/{id}/playlists and POST /playlists/{id}/tracks now answer 403
// Forbidden. The replacements are POST /me/playlists and .../items.
export async function createPlaylist(user, { name, description = '', isPublic = false }) {
  return api(user, 'POST', '/me/playlists', {
    name,
    description,
    public: isPublic,
  });
}

/** Appends in batches: the API takes at most 100 URIs per request. */
export async function addTracksToPlaylist(user, playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await api(user, 'POST', `/playlists/${encodeURIComponent(playlistId)}/items`, {
      uris: uris.slice(i, i + 100),
    });
  }
}

/**
 * Swaps a playlist's contents for `uris`, keeping the playlist itself — same
 * id, same URL, same followers. PUT replaces with up to 100 URIs (and empties
 * the playlist when given none); the rest are appended after.
 */
export async function replacePlaylistTracks(user, playlistId, uris) {
  const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
  await api(user, 'PUT', path, { uris: uris.slice(0, 100) });
  for (let i = 100; i < uris.length; i += 100) {
    await api(user, 'POST', path, { uris: uris.slice(i, i + 100) });
  }
}
