# Ronda 🎧

Blend your friends' latest Spotify listens into one shared playlist.

Start a **ronda**, share its link, and everyone who joins connects their own
Spotify account. One click then interleaves each member's most recently played
tracks — newest first, deduplicated, evenly balanced — into a playlist saved to
Spotify.

## How it works

1. **Connect Spotify** — you log in via Spotify OAuth and start a ronda (a room).
2. **Invite** — share the room link (`/r/<id>`). Each friend logs in with their
   own Spotify account too. This is required by Spotify: an account's listening
   history can only be read with that account's permission, so there's no way to
   pull a friend's recent tracks without them connecting.
3. **Blend** — any member hits *Blend on Spotify*. The server pulls each
   member's [recently played tracks](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)
   (up to 50 per person), interleaves them round-robin so everyone contributes
   equally, removes duplicates, and creates a private playlist on the account of
   whoever pressed the button.

## Quick start

Requirements: **Node.js 18.17+** (uses the built-in `fetch`).

### 1. Create a Spotify app

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and create an app (choose **Web API** when asked which APIs you'll use).
2. In the app's settings, add this **Redirect URI** exactly:

   ```
   http://127.0.0.1:3000/auth/callback
   ```

   > Spotify requires the literal loopback IP `127.0.0.1` — `localhost` is not
   > accepted for new apps. Open the site at `http://127.0.0.1:3000` too, not
   > `http://localhost:3000`, so cookies and the OAuth redirect line up.
3. Copy the app's **Client ID** and **Client Secret**.
4. **Add your friends as users**: while the app is in *Development Mode*,
   Spotify only lets allowlisted accounts log in. In the app's
   **User Management** tab, add the name + email of each Spotify account that
   will join (up to 25). Without this, friends get a 403 when connecting.

### 2. Configure and run

```bash
cp .env.example .env    # then fill in SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
npm install
npm start               # or: npm run dev (auto-restarts on changes)
```

Open http://127.0.0.1:3000, connect Spotify, start a ronda, and share the
invite link.

### Configuration

| Variable                | Required | Default                 | Purpose                                            |
| ----------------------- | -------- | ----------------------- | -------------------------------------------------- |
| `SPOTIFY_CLIENT_ID`     | yes      | —                       | From your Spotify app                              |
| `SPOTIFY_CLIENT_SECRET` | yes      | —                       | From your Spotify app                              |
| `BASE_URL`              | no       | `http://127.0.0.1:3000` | Public URL; redirect URI is `$BASE_URL/auth/callback` |
| `PORT`                  | no       | `3000`                  | Port to listen on                                  |
| `SESSION_SECRET`        | no       | random per boot         | Signs session cookies; set it so logins survive restarts |
| `DATA_DIR`              | no       | `data`                  | Where the JSON store lives (gitignored)            |

## Project layout

```
server/
  index.js       entry point (env, store init, listen)
  app.js         Express wiring, static files, error handling
  config.js      environment configuration
  session.js     HMAC-signed cookie sessions (no session DB)
  store.js       file-backed store for users, rooms, playlist history
  spotify.js     OAuth + Spotify Web API client (auto token refresh, 429 retry)
  blend.js       the round-robin blending algorithm (pure, unit-tested)
  routes/
    auth.js      /auth/login, /auth/callback, /auth/logout
    api.js       JSON API (rooms, members, recent tracks, playlist generation)
public/          static frontend (vanilla JS modules, no build step)
test/            node:test unit tests — run with `npm test`
```

### API overview

| Method & path                  | Auth   | Purpose                                        |
| ------------------------------ | ------ | ---------------------------------------------- |
| `GET  /api/me`                 | ✓      | Current user + their rondas                    |
| `POST /api/rooms`              | ✓      | Create a ronda                                 |
| `GET  /api/rooms/:id`          | —      | Room info (playlists only shown to members)    |
| `POST /api/rooms/:id/join`     | ✓      | Join a ronda                                   |
| `GET  /api/rooms/:id/recent`   | member | Everyone's latest listens (cached ~60s; `?fresh=1` bypasses) |
| `POST /api/rooms/:id/playlist` | member | Blend + create the playlist `{ limit?, name? }` |

Spotify scopes requested: `user-read-recently-played`,
`playlist-modify-public`, `playlist-modify-private` — the minimum for reading
each member's history and saving the playlist.

## Notes & limitations

- **"Recently played" means the last ~50 completed plays.** Spotify updates the
  list shortly after a track finishes; the currently playing song may not show
  up yet.
- Playlists are created **private, on the account of whoever clicks Blend**.
- Storage is a single JSON file (`data/store.json`). It contains OAuth tokens —
  keep it out of version control (it's gitignored) and treat it like a secret.
- Sessions are signed cookies; set `SESSION_SECRET` in production.
- In Spotify *Development Mode* only allowlisted users (max 25) can connect;
  request an extended quota from Spotify to go beyond that.

## Ideas for later

- Scheduled auto-blends (e.g. every Friday) via a cron job hitting the blend logic
- Weight tracks by how many members played them, or exclude tracks from past blends
- Leave/delete rooms, room settings, transfer ownership
- Collaborative playlist mode (one shared playlist updated in place)
- Swap the JSON store for SQLite/Postgres

---

Ronda is a hobby project and is not affiliated with Spotify.
