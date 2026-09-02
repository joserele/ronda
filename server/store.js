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
