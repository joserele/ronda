import crypto from 'node:crypto';
import { Router } from 'express';
import { readSession, clearSession } from '../session.js';
import * as store from '../store.js';
import { getRecentlyPlayed, createPlaylist, addTracksToPlaylist } from '../spotify.js';
import { blendRecent } from '../blend.js';

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

// ---- Recently-played fetching (shared by preview + generate) ----------

const recentCache = new Map(); // roomId -> { at, byUid: { uid: { tracks, error } } }
const RECENT_TTL_MS = 60_000;

async function fetchRecentForRoom(room, { fresh = false } = {}) {
  const cached = recentCache.get(room.id);
  if (!fresh && cached && Date.now() - cached.at < RECENT_TTL_MS) return cached;

  const members = room.memberUids.map(store.getUser).filter(Boolean);
  const results = await Promise.allSettled(members.map((m) => getRecentlyPlayed(m, 50)));
  const byUid = {};
  members.forEach((member, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') {
      byUid[member.uid] = { tracks: result.value };
    } else {
      console.warn(`Recently-played fetch failed for ${member.displayName}:`, result.reason?.message);
      byUid[member.uid] = { tracks: [], error: 'unavailable' };
    }
  });
  const entry = { at: Date.now(), byUid };
  recentCache.set(room.id, entry);
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
  recentCache.delete(room.id);
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

// Per-member preview of everyone's latest listens.
apiRouter.get('/api/rooms/:id/recent', requireAuth, async (req, res, next) => {
  try {
    const room = requireMembership(req, res);
    if (!room) return;
    const entry = await fetchRecentForRoom(room, { fresh: 'fresh' in req.query });
    const members = room.memberUids
      .map(store.getUser)
      .filter(Boolean)
      .map((member) => {
        const data = entry.byUid[member.uid] ?? { tracks: [] };
        return {
          member: presentMember(member, req.user.uid),
          tracks: data.tracks.slice(0, 5),
          totalRecent: data.tracks.length,
          error: data.error,
        };
      });
    res.json({ members, fetchedAt: entry.at });
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

    const entry = await fetchRecentForRoom(room, { fresh: true });
    const members = room.memberUids.map(store.getUser).filter(Boolean);
    const contributing = [];
    const skipped = [];
    for (const member of members) {
      const data = entry.byUid[member.uid];
      if (data?.tracks?.length) contributing.push({ member, tracks: data.tracks });
      else skipped.push(member.displayName);
    }
    if (!contributing.length) {
      return res.status(409).json({
        error: 'no_tracks',
        message:
          "Nobody's listening history could be read. Play some music on Spotify (or reconnect) and try again.",
      });
    }

    const blended = blendRecent(
      contributing.map(({ member, tracks }) => tracks.map((t) => ({ ...t, uid: member.uid }))),
      { limit }
    );

    const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const name = customName || `${room.name} · ${dateLabel}`;
    const contributors = contributing.map(({ member }) => member.displayName).join(', ');
    const description = `The latest listens of ${contributors}. Blended with Ronda.`.slice(0, 250);

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
      contributions,
      skippedMembers: skipped,
    };
    store.addPlaylistToRoom(room.id, record);
    res.status(201).json({ playlist: presentPlaylist(record) });
  } catch (err) {
    next(err);
  }
});
