import { Router } from 'express';
import { readSession, clearSession } from '../session.js';
import * as store from '../store.js';
import {
  getRecentlyPlayed,
  getTopTracks,
  createPlaylist,
  addTracksToPlaylist,
  replacePlaylistTracks,
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

function presentBlend(blend, viewerUid, room) {
  if (!blend) return null;
  const nameOf = (uid) => store.getUser(uid)?.displayName ?? 'Someone';
  return {
    name: blend.name,
    url: blend.url,
    trackCount: blend.trackCount,
    // Blends made before the source picker existed were all recently-played.
    source: blend.source ?? 'recent',
    createdAt: blend.createdAt,
    createdBy: nameOf(blend.createdByUid),
    refreshedAt: blend.refreshedAt ?? null,
    refreshedBy: blend.refreshedByUid ? nameOf(blend.refreshedByUid) : null,
    contributions: Object.entries(blend.contributions ?? {}).map(([uid, count]) => ({
      name: nameOf(uid),
      count,
    })),
    skippedMembers: blend.skippedMembers ?? [],
    // Anyone in the ronda keeps it current; only its creator or the ronda's
    // owner can detach it and start over.
    canRemove: Boolean(
      viewerUid && (viewerUid === blend.createdByUid || viewerUid === room?.ownerUid)
    ),
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
  // History and the invite code are for members only — the code is the thing
  // that lets someone in, so it must never reach a non-member.
  if (isMember) {
    out.blend = presentBlend(room.blend, viewerUid, room);
    out.invite = room.inviteCode;
  }
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
    hasBlend: Boolean(room.blend),
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
  // Members can re-hit this harmlessly; newcomers need the current invite.
  if (!room.memberUids.includes(req.user.uid) && !store.inviteMatches(room, req.body?.invite)) {
    return res.status(403).json({
      error: 'bad_invite',
      message: 'This invite link is no longer valid — ask someone in the ronda for a fresh one.',
    });
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
const clampLimit = (value, fallback = 50) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(5, Math.floor(n))) : fallback;
};

/**
 * Pulls everyone's tracks fresh and interleaves them. Shared by creating a
 * blend and refreshing one, so a refresh produces exactly what a new blend
 * would have — only the destination differs.
 *
 * @returns {{blended: object[], contributors: string, contributions: object,
 *            skipped: string[]}|{failure: object}} `failure` is a ready-to-send body
 */
async function buildBlend(room, source, limit) {
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
    return {
      failure: anyNeedsReconnect
        ? {
            error: 'needs_reconnect',
            message:
              'Ronda needs permission to read your top tracks. Everyone in this ronda has to log in again once — then blend away.',
          }
        : {
            error: 'no_tracks',
            message:
              "Nobody's listening history could be read. Play some music on Spotify (or reconnect) and try again.",
          },
    };
  }

  const blended = blendTracks(
    contributing.map(({ member, tracks }) => tracks.map((t) => ({ ...t, uid: member.uid }))),
    { limit }
  );
  const contributions = {};
  for (const track of blended) contributions[track.uid] = (contributions[track.uid] ?? 0) + 1;

  return {
    blended,
    contributions,
    skipped,
    contributors: contributing.map(({ member }) => member.displayName).join(', '),
  };
}

/**
 * Creates the ronda's blend, or refreshes it in place if it already has one.
 * One button, one playlist — no history to manage and nothing new landing in
 * anyone's library on a second press.
 *
 * Refreshing re-runs the blend's stored recipe (source + length), so the result
 * never depends on whichever preview the presser happened to be looking at.
 */
apiRouter.post('/api/rooms/:id/blend', requireAuth, async (req, res, next) => {
  try {
    const room = requireMembership(req, res);
    if (!room) return;
    const existing = room.blend;

    // The blend lives in its creator's library, and it's their token that can
    // rewrite it — so a refresh acts as them, whoever pressed the button.
    const owner = existing ? store.getUser(existing.createdByUid) : req.user;
    if (existing && !owner) {
      return res.status(409).json({
        error: 'creator_gone',
        message:
          "This blend's creator is no longer connected to Ronda. Remove it and blend a new one.",
      });
    }

    const source = existing ? sourceFrom(existing.source) : sourceFrom(req.body?.source);
    const limit = existing ? clampLimit(existing.limit ?? existing.trackCount) : clampLimit(req.body?.limit);

    const built = await buildBlend(room, source, limit);
    if (built.failure) return res.status(409).json(built.failure);
    const { blended, contributions, skipped, contributors } = built;
    const uris = blended.map((t) => t.uri);
    const description = SOURCES[source].describe(contributors).slice(0, 250);

    if (existing) {
      await replacePlaylistTracks(owner, existing.spotifyId, uris);
      const updated = store.updateRoomBlend(room.id, {
        trackCount: blended.length,
        contributions,
        skippedMembers: skipped,
        refreshedAt: new Date().toISOString(),
        refreshedByUid: req.user.uid,
      });
      return res.json({ blend: presentBlend(updated, req.user.uid, room) });
    }

    const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const customName = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    const name = customName || `${room.name} · ${dateLabel}`;
    const playlist = await createPlaylist(req.user, { name, description, isPublic: false });
    await addTracksToPlaylist(req.user, playlist.id, uris);

    const blend = store.setRoomBlend(room.id, {
      spotifyId: playlist.id,
      name,
      url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
      trackCount: blended.length,
      source,
      limit,
      createdAt: new Date().toISOString(),
      createdByUid: req.user.uid,
      refreshedAt: null,
      refreshedByUid: null,
      contributions,
      skippedMembers: skipped,
    });
    res.status(201).json({ blend: presentBlend(blend, req.user.uid, room) });
  } catch (err) {
    next(err);
  }
});

// Detach the blend so the ronda can start a fresh one. Ronda forgets it; the
// Spotify playlist stays in the library of whoever created it.
apiRouter.delete('/api/rooms/:id/blend', requireAuth, (req, res) => {
  const room = requireMembership(req, res);
  if (!room) return;
  if (!room.blend) {
    return res.status(404).json({ error: 'no_blend', message: "This ronda hasn't been blended yet." });
  }
  if (room.blend.createdByUid !== req.user.uid && room.ownerUid !== req.user.uid) {
    return res.status(403).json({
      error: 'not_yours',
      message:
        'Only the person who made this blend (or whoever started the ronda) can remove it.',
    });
  }
  store.clearRoomBlend(room.id);
  res.status(204).end();
});

// Remove someone else. Owner only// Remove someone else. Owner only, and never yourself — the owner's exit is
// deleting the ronda, which is a different and more deliberate decision.
apiRouter.delete('/api/rooms/:id/members/:uid', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'room_not_found', message: "This ronda doesn't exist." });
  }
  if (room.ownerUid !== req.user.uid) {
    return res.status(403).json({
      error: 'not_owner',
      message: 'Only whoever started this ronda can remove people from it.',
    });
  }
  if (req.params.uid === req.user.uid) {
    return res.status(409).json({
      error: 'cannot_remove_self',
      message: "You started this ronda — delete it instead of removing yourself.",
    });
  }
  if (!room.memberUids.includes(req.params.uid)) {
    return res.status(404).json({ error: 'not_a_member', message: "They're not in this ronda." });
  }
  store.removeMember(room.id, req.params.uid);
  clearRoomCache(room.id);
  res.status(204).end();
});

// Retire every invite link handed out so far and mint a new one. Owner only.
// Existing members are unaffected — their membership, not the link, is what
// keeps them in.
apiRouter.post('/api/rooms/:id/invite', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'room_not_found', message: "This ronda doesn't exist." });
  }
  if (room.ownerUid !== req.user.uid) {
    return res.status(403).json({
      error: 'not_owner',
      message: 'Only whoever started this ronda can change its invite link.',
    });
  }
  res.json({ invite: store.rotateInviteCode(room.id) });
});

// Step out of a ronda. The owner can't — deleting is their exit, and it needs
// to be a deliberate, separate decision.
apiRouter.post('/api/rooms/:id/leave', requireAuth, (req, res) => {
  const room = requireMembership(req, res);
  if (!room) return;

  if (room.ownerUid === req.user.uid) {
    return res.status(409).json({
      error: 'owner_cannot_leave',
      message: "You started this ronda, so you can't leave it — delete it instead.",
    });
  }
  store.removeMember(room.id, req.user.uid);
  clearRoomCache(room.id); // the member list changed
  res.status(204).end();
});

// Forget a whole ronda, history and all. Only whoever started it can; the
// Spotify playlists its blends produced are left alone.
apiRouter.delete('/api/rooms/:id', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'room_not_found', message: "This ronda doesn't exist." });
  }
  if (room.ownerUid !== req.user.uid) {
    return res.status(403).json({
      error: 'not_owner',
      message: 'Only whoever started this ronda can delete it.',
    });
  }
  store.deleteRoom(room.id);
  clearRoomCache(room.id);
  res.status(204).end();
});

