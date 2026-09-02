// File-backed in-memory store. Good enough for a small group of users;
// swap for a real database later without touching the routes' call sites.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { config } from './config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(ROOT, config.dataDir);
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const state = { users: {}, rooms: {} };
let saveTimer = null;

export async function initStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    state.users = parsed.users ?? {};
    state.rooms = parsed.rooms ?? {};
    // Rooms created before invite codes existed get one now. Their old bare
    // /r/<id> links stop working for new joiners — that's the point of codes.
    let backfilled = 0;
    for (const room of Object.values(state.rooms)) {
      if (!room.inviteCode) {
        room.inviteCode = newInviteCode();
        backfilled += 1;
      }
    }
    if (backfilled) {
      console.log(`Issued invite codes for ${backfilled} existing ronda(s) — reshare their links.`);
      scheduleSave();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not read ${STORE_FILE}: ${err.message}`);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save().catch((err) => console.error('Failed to persist store:', err));
  }, 200);
  saveTimer.unref?.();
}

async function save() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STORE_FILE);
}

const newRoomId = () => crypto.randomBytes(6).toString('base64url');
// The joinable secret, separate from the room id so it can be rotated without
// breaking the room's URL or existing members' bookmarks.
const newInviteCode = () => crypto.randomBytes(12).toString('base64url');

// ---- Users ------------------------------------------------------------

export const getUser = (uid) => state.users[uid] ?? null;

export function upsertUser({ spotifyId, displayName, avatarUrl, tokens }) {
  let user = Object.values(state.users).find((u) => u.spotifyId === spotifyId);
  if (!user) {
    user = { uid: crypto.randomUUID(), spotifyId, createdAt: new Date().toISOString() };
    state.users[user.uid] = user;
  }
  Object.assign(user, {
    displayName,
    avatarUrl,
    tokens,
    needsReconnect: false,
    updatedAt: new Date().toISOString(),
  });
  scheduleSave();
  return user;
}

export function updateUserTokens(uid, tokens) {
  const user = state.users[uid];
  if (!user) return;
  user.tokens = tokens;
  user.needsReconnect = false;
  scheduleSave();
}

export function setNeedsReconnect(uid, value) {
  const user = state.users[uid];
  if (!user) return;
  user.needsReconnect = value;
  scheduleSave();
}

// ---- Rooms ------------------------------------------------------------

export function createRoom(name, ownerUid) {
  let id;
  do {
    id = newRoomId();
  } while (state.rooms[id]);
  const room = {
    id,
    name,
    ownerUid,
    inviteCode: newInviteCode(),
    memberUids: [ownerUid],
    playlists: [],
    createdAt: new Date().toISOString(),
  };
  state.rooms[id] = room;
  scheduleSave();
  return room;
}

export const getRoom = (id) => state.rooms[id] ?? null;

export function joinRoom(roomId, uid) {
  const room = state.rooms[roomId];
  if (!room) return null;
  if (!room.memberUids.includes(uid)) {
    room.memberUids.push(uid);
    scheduleSave();
  }
  return room;
}

/** Constant-time check that `code` is this room's current invite. */
export function inviteMatches(room, code) {
  if (!room?.inviteCode || typeof code !== 'string' || !code) return false;
  const expected = Buffer.from(room.inviteCode);
  const given = Buffer.from(code);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Issues a fresh invite code, instantly retiring every link handed out so far. */
export function rotateInviteCode(roomId) {
  const room = state.rooms[roomId];
  if (!room) return null;
  room.inviteCode = newInviteCode();
  scheduleSave();
  return room.inviteCode;
}

/**
 * Drops a member from a ronda, whether they left or the owner removed them.
 * Their past blends stay in its history —
 * they're still credited by uid, and the user record itself is untouched, so
 * they can rejoin with the invite link and pick up where they left off.
 *
 * @returns {object|null} the room, or null if it or the membership is gone
 */
export function removeMember(roomId, uid) {
  const room = state.rooms[roomId];
  if (!room) return null;
  const i = room.memberUids.indexOf(uid);
  if (i === -1) return null;
  room.memberUids.splice(i, 1);
  scheduleSave();
  return room;
}

/**
 * Forgets a whole ronda and its blend history. The Spotify playlists those
 * blends produced are untouched — they live in their creators' libraries.
 *
 * @returns {object|null} the removed room, or null if it was already gone
 */
export function deleteRoom(roomId) {
  const room = state.rooms[roomId];
  if (!room) return null;
  delete state.rooms[roomId];
  scheduleSave();
  return room;
}

export function roomsForUser(uid) {
  return Object.values(state.rooms)
    .filter((r) => r.memberUids.includes(uid))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addPlaylistToRoom(roomId, playlist) {
  const room = state.rooms[roomId];
  if (!room) return;
  room.playlists.unshift(playlist);
  scheduleSave();
}

/** Applies a patch to one blend's record — used when a blend is refreshed in place. */
export function updatePlaylistInRoom(roomId, playlistId, patch) {
  const room = state.rooms[roomId];
  if (!room) return null;
  const playlist = room.playlists.find((p) => p.id === playlistId);
  if (!playlist) return null;
  Object.assign(playlist, patch);
  scheduleSave();
  return playlist;
}

/**
 * Forgets a blend. Only Ronda's own record goes — the playlist itself stays in
 * whoever created it's Spotify library.
 *
 * @returns {object|null} the removed record, or null if the room/blend is gone
 */
export function removePlaylistFromRoom(roomId, playlistId) {
  const room = state.rooms[roomId];
  if (!room) return null;
  const i = room.playlists.findIndex((p) => p.id === playlistId);
  if (i === -1) return null;
  const [removed] = room.playlists.splice(i, 1);
  scheduleSave();
  return removed;
}
