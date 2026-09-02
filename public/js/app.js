// Landing + dashboard page.
import { api, el, timeAgo, toast, renderHeader } from './common.js';

const $ = (id) => document.getElementById(id);

const AUTH_ERROR_MESSAGES = {
  access_denied: 'You cancelled the Spotify login.',
  state_mismatch: 'The login attempt expired — please try again.',
  login_failed: "Spotify login didn't go through. Please try again.",
};

async function main() {
  const params = new URLSearchParams(location.search);
  const authError = params.get('auth_error');
  if (authError) {
    toast(AUTH_ERROR_MESSAGES[authError] ?? `Spotify login failed (${authError}).`, 'error');
    history.replaceState({}, '', '/');
  }
  // Set by the room page on its way out, since its own toast dies with the page.
  const deleted = params.get('deleted');
  if (deleted) {
    toast(`“${deleted}” was deleted. Its Spotify playlists are untouched.`, 'success');
    history.replaceState({}, '', '/');
  }
  const left = params.get('left');
  if (left) {
    toast(`You left “${left}”. Rejoin any time with the invite link.`, 'success');
    history.replaceState({}, '', '/');
  }

  let me = null;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }

  renderHeader(me?.user);
  $('loading').hidden = true;

  if (!me) {
    $('landing').hidden = false;
    return;
  }
  renderDashboard(me);
}

function renderDashboard(me) {
  $('dashboard').hidden = false;
  const grid = $('rooms-grid');
  grid.textContent = '';
  $('no-rooms').hidden = me.rooms.length > 0;

  for (const room of me.rooms) {
    const members = `${room.memberCount} ${room.memberCount === 1 ? 'member' : 'members'}`;
    const playlists = room.hasBlend ? 'playlist ready' : 'not blended yet';
    grid.append(
      el(
        'a',
        { class: 'room-card', href: `/r/${encodeURIComponent(room.id)}` },
        el('h3', { text: room.name }),
        el('div', { class: 'meta', text: `${members} · ${playlists}` }),
        el('div', { class: 'meta', text: `started ${timeAgo(room.createdAt)}` })
      )
    );
  }

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('room-name-input');
    const name = input.value.trim();
    if (!name) return;
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const { room } = await api('/api/rooms', { method: 'POST', body: { name } });
      location.href = `/r/${encodeURIComponent(room.id)}`;
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  });
}

main().catch((err) => {
  console.error(err);
  toast('Something went wrong loading the page.', 'error');
});
