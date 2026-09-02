import crypto from 'node:crypto';
import { Router } from 'express';
import { readSession, clearSession } from '../session.js';
import * as store from '../store.js';
import {
  getRecentlyPlayed,
  getTopTracks,
  createPlaylist,
  addTracksToPlaylist,
  isMissingScope,
} from '../spotify.js';
import { blendTracks } from '../blend.js';

export const apiRouter = Router();

// Attach the logged-in user (if any) to every API request.
apiRouter.use((req, res, next) => {
  const session = readSession(req);
  req.user = session?.uid ? store.getUser(session.uid) : null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    clearSession(req, res); // drop stale cookies pointing at users we no longer know
    return res.status(401).json({ error: 'auth_required', message: 'Log in with Spotify first.' });
  }
  next();
}

// ---- Presenters (what the frontend is allowed to see) -----------------

function presentMember(user, viewerUid) {
  return {
    uid: user.uid,
    name: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    isYou: user.uid === viewerUid,
    needsReconnect: Boolean(user.needsReconnect),
  };
}

function presentPlaylist(playlist) {
  const nameOf = (uid) => store.getUser(uid)?.displayName ?? 'Someone';
  return {
    id: playlist.id,
    name: playlist.name,
    url: playlist.url,
    trackCount: playlist.trackCount,
    createdAt: playlist.createdAt,
    // Blends made before the source picker existed were all recently-played.
    source: playlist.source ?? 'recent',
    createdBy: nameOf(playlist.createdByUid),
    contributions: Object.entries(playlist.contributions ?? {}).map(([uid, count]) => ({
      name: nameOf(uid),
      count,
    })),
    skippedMembers: playlist.skippedMembers ?? [],
  };
}

function presentRoom(room, viewerUid) {
  const isMember = viewerUid ? room.memberUids.includes(viewerUid) : false;
  const members = room.memberUids
    .map(store.getUser)
    .filter(Boolean)
    .map((u) => presentMember(u, viewerUid));
  const out = {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    memberCount: members.length,
    members,
    isMember,
    isOwner: viewerUid === room.ownerUid,
  };
  // Playlist history is for members only.
  if (isMember) out.playlists = room.playlists.map(presentPlaylist);
  return out;
}

// ---- Track sources (shared by preview + generate) ---------------------

/**
 * What a blend is made of. Each source returns one list per member, already
 * ordered best-first — blendTracks() interleaves them without caring which.
 */
const SOURCES = {
  top: {
    heading: 'On repeat lately',
    // Spotify's short_term ranking covers roughly the last four weeks.
    fetch: (user) => getTopTracks(user, 50, 'short_term'),
    describe: (names) => `The tracks ${names} have had on repeat lately. Blended with Ronda.`,
  },
  recent: {
    heading: 'Latest listens',
    fetch: (user) => getRecentlyPlayed(user, 50),
    describe: (names) => `The latest listens of ${names}. Blended with Ronda.`,
  },
};
const DEFAULT_SOURCE = 'top';

const sourceFrom = (value) =>
  typeof value === 'string' && Object.hasOwn(SOURCES, value) ? value : DEFAULT_SOURCE;

const trackCache = new Map(); // `${roomId}:${source}` -> { at, byUid: { uid: { tracks, error } } }
const TRACKS_TTL_MS = 60_000;

const clearRoomCache = (roomId) => {
  for (const source of Object.keys(SOURCES)) trackCache.delete(`${roomId}:${source}`);
};

/**
 * Drop a member's cached results after they log in again, so a grant they just
 * gave isn't hidden behind a minute of cached "needs reconnect".
 */
export function clearCachesForUser(uid) {
  for (const room of store.roomsForUser(uid)) clearRoomCache(room.id);
}

async function fetchTracksForRoom(room, source, { fresh = false } = {}) {
  const key = `${room.id}:${source}`;
  const cached = trackCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < TRACKS_TTL_MS) return cached;

  const members = room.memberUids.map(store.getUser).filter(Boolean);
  const results = await Promise.allSettled(members.map((m) => SOURCES[source].fetch(m)));
  const byUid = {};
  members.forEach((member, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') {
      byUid[member.uid] = { tracks: result.value };
    } else {
      console.warn(`${source} fetch failed for ${member.displayName}:`, result.reason?.message);
      // A missing scope is fixable by the member alone — say so instead of
      // lumping it in with transient Spotify failures.
      byUid[member.uid] = {
        tracks: [],
        error: isMissingScope(result.reason) ? 'needs_reconnect' : 'unavailable',
      };
    }
  });
  const entry = { at: Date.now(), byUid };
  trackCache.set(key, entry);
  return entry;
}

// ---- Routes -----------------------------------------------------------

apiRouter.get('/api/me', requireAuth, (req, res) => {
  const rooms = store.roomsForUser(req.user.uid).map((room) => ({
    id: room.id,
    name: room.name,
    memberCount: room.memberUids.length,
    playlistCount: room.playlists.length,
    createdAt: room.createdAt,
  }));
  res.json({ user: presentMember(req.user, req.user.uid), rooms });
});

apiRouter.post('/api/rooms', requireAuth, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 60) {
    return res
      .status(400)
      .json({ error: 'invalid_name', message: 'Give your ronda a name (1–60 characters).' });
  }
  const room = store.createRoom(name, req.user.uid);
  res.status(201).json({ room: presentRoom(room, req.user.uid) });
});

apiRouter.get('/api/rooms/:id', (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'room_not_found', message: "This ronda doesn't exist." });
  }
  res.json({ room: presentRoom(room, req.user?.uid) });
});

apiRouter.post('/api/rooms/:id/join', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'room_not_found', message: "This ronda doesn't exist." });
  }
  store.joinRoom(room.id, req.user.uid);
  clearRoomCache(room.id);
  res.json({ room: presentRoom(room, req.user.uid) });
});

function requireMembership(req, res) {
  const room = store.getRoom(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'room_not_found', message: "This ronda doesn't exist." });
    return null;
  }
  if (!room.memberUids.includes(req.user.uid)) {
    res.status(403).json({ error: 'not_a_member', message: 'Join this ronda first.' });
    return null;
  }
  return room;
}

// Per-member preview of whatever source the room is currently looking at.
apiRouter.get('/api/rooms/:id/tracks', requireAuth, async (req, res, next) => {
  try {
    const room = requireMembership(req, res);
    if (!room) return;
    const source = sourceFrom(req.query.source);
    const entry = await fetchTracksForRoom(room, source, { fresh: 'fresh' in req.query });
    const members = room.memberUids
      .map(store.getUser)
      .filter(Boolean)
      .map((member) => {
        const data = entry.byUid[member.uid] ?? { tracks: [] };
        return {
          member: presentMember(member, req.user.uid),
          tracks: data.tracks.slice(0, 5),
          totalTracks: data.tracks.length,
          error: data.error,
        };
      });
    res.json({ source, members, fetchedAt: entry.at });
  } catch (err) {
    next(err);
  }
});

// The main event: blend everyone's latest listens into a playlist
// on the requesting member's Spotify account.
apiRouter.post('/api/rooms/:id/playlist', requireAuth, async (req, res, next) => {
  try {
    const room = requireMembership(req, res);
    if (!room) return;

    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(5, Math.floor(limitRaw))) : 50;
    const customName = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';

    const source = sourceFrom(req.body?.source);
    const entry = await fetchTracksForRoom(room, source, { fresh: true });
    const members = room.memberUids.map(store.getUser).filter(Boolean);
    const contributing = [];
    const skipped = [];
    let anyNeedsReconnect = false;
    for (const member of members) {
      const data = entry.byUid[member.uid];
      if (data?.tracks?.length) contributing.push({ member, tracks: data.tracks });
      else {
        skipped.push(member.displayName);
        if (data?.error === 'needs_reconnect') anyNeedsReconnect = true;
      }
    }
    if (!contributing.length) {
      // Switching sources can outrun the permissions people granted earlier,
      // so point at the fix rather than at Spotify.
      return res.status(409).json(
        anyNeedsReconnect
          ? {
              error: 'needs_reconnect',
              message:
                'Ronda needs permission to read your top tracks. Everyone in this ronda has to log in again once — then blend away.',
            }
          : {
              error: 'no_tracks',
              message:
                "Nobody's listening history could be read. Play some music on Spotify (or reconnect) and try again.",
            }
      );
    }

    const blended = blendTracks(
      contributing.map(({ member, tracks }) => tracks.map((t) => ({ ...t, uid: member.uid }))),
      { limit }
    );

    const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const name = customName || `${room.name} · ${dateLabel}`;
    const contributors = contributing.map(({ member }) => member.displayName).join(', ');
    const description = SOURCES[source].describe(contributors).slice(0, 250);

    const playlist = await createPlaylist(req.user, { name, description, isPublic: false });
    await addTracksToPlaylist(req.user, playlist.id, blended.map((t) => t.uri));

    const contributions = {};
    for (const track of blended) contributions[track.uid] = (contributions[track.uid] ?? 0) + 1;

    const record = {
      id: crypto.randomUUID(),
      spotifyId: playlist.id,
      name,
      url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
      trackCount: blended.length,
      createdAt: new Date().toISOString(),
      createdByUid: req.user.uid,
      source,
      contributions,
      skippedMembers: skipped,
    };
    store.addPlaylistToRoom(room.id, record);
    res.status(201).json({ playlist: presentPlaylist(record) });
  } catch (err) {
    next(err);
  }
});
