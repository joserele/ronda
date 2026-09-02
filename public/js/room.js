// Room ("ronda") page: members, what they're playing, and the blend button.
import { api, el, timeAgo, toast, renderHeader, avatar } from './common.js';

// Keep these keys in sync with SOURCES in server/routes/api.js.
const SOURCES = {
  top: {
    label: 'On repeat lately',
    blurb:
      'Interleaves the tracks everyone has played most over the last few weeks — ' +
      'top picks first, no repeats — and saves the playlist to your Spotify account.',
    empty: 'No top tracks yet — Spotify needs a few weeks of listening to rank them.',
  },
  recent: {
    label: 'Latest listens',
    blurb:
      "Interleaves everyone's most recent tracks — newest first, no repeats — " +
      'and saves the playlist to your Spotify account.',
    empty: 'No recent listens found — time to play something!',
  },
};
const DEFAULT_SOURCE = 'top';

const roomId = decodeURIComponent(location.pathname.split('/')[2] || '');
const loginJoinHref = `/auth/login?join=${encodeURIComponent(roomId)}`;
const $ = (id) => document.getElementById(id);

let me = null;
let room = null;
let source = DEFAULT_SOURCE;

async function main() {
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
  renderHeader(me?.user, loginJoinHref);

  try {
    ({ room } = await api(`/api/rooms/${encodeURIComponent(roomId)}`));
  } catch (err) {
    $('loading').hidden = true;
    renderMissing(err);
    return;
  }

  document.title = `${room.name} · Ronda`;
  $('loading').hidden = true;
  render();
  if (room.isMember) {
    if (me?.user?.needsReconnect) showReconnect();
    refreshTracks(false);
  }
}

function renderMissing(err) {
  const root = $('room-root');
  root.hidden = false;
  root.append(
    el(
      'div',
      { class: 'panel join-panel' },
      el('h2', { text: err.status === 404 ? "This ronda doesn't exist" : 'Could not load this ronda' }),
      el('p', { text: err.status === 404 ? 'Double-check the link you were sent.' : err.message }),
      el('a', { class: 'btn btn-ghost', href: '/', text: 'Back to Ronda' })
    )
  );
}

function render() {
  const root = $('room-root');
  root.hidden = false;
  root.textContent = '';

  // --- Heading + invite ---
  const memberWord = room.memberCount === 1 ? 'member' : 'members';
  root.append(
    el(
      'div',
      { class: 'room-head' },
      el('h1', { text: room.name }),
      el(
        'div',
        { style: 'display:flex;gap:10px;align-items:center' },
        el('span', { class: 'avatar-stack' }, room.members.slice(0, 6).map((m) => avatar(m, 'avatar-sm'))),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Copy invite link',
          onclick: copyInvite,
        })
      )
    ),
    el('p', {
      class: 'room-sub',
      text: `${room.memberCount} ${memberWord} · started ${timeAgo(room.createdAt)} · anyone with the link can join`,
    })
  );

  if (!room.isMember) {
    renderJoinPanel(root);
    return;
  }

  root.append(el('div', { id: 'reconnect-notice' }));

  // --- What everyone's playing, from the selected source ---
  const sourceSelect = el(
    'select',
    { id: 'source-select', 'aria-label': 'What to blend' },
    Object.entries(SOURCES).map(([key, meta]) =>
      el('option', { value: key, text: meta.label, selected: key === source })
    )
  );
  sourceSelect.addEventListener('change', () => {
    source = sourceSelect.value;
    applySource();
    renderMemberSkeletons();
    refreshTracks(false);
  });

  root.append(
    el(
      'div',
      { class: 'section-head' },
      el('h2', { id: 'source-heading', text: SOURCES[source].label }),
      el(
        'div',
        { class: 'section-actions' },
        sourceSelect,
        el('button', {
          id: 'refresh-btn',
          class: 'btn btn-ghost btn-sm',
          text: 'Refresh',
          onclick: () => refreshTracks(true),
        })
      )
    ),
    el('div', { id: 'members-grid', class: 'members-grid' })
  );
  renderMemberSkeletons();

  // --- Generate panel ---
  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const genForm = el(
    'form',
    { id: 'gen-form', class: 'gen-form' },
    el(
      'select',
      { id: 'gen-limit', 'aria-label': 'Playlist length' },
      el('option', { value: '20', text: '20 tracks' }),
      el('option', { value: '50', text: '50 tracks', selected: true }),
      el('option', { value: '100', text: '100 tracks' })
    ),
    el('input', { id: 'gen-name', maxlength: '100', placeholder: `${room.name} · ${dateLabel}` }),
    el('button', { class: 'btn btn-primary', type: 'submit', text: 'Blend on Spotify' })
  );
  genForm.addEventListener('submit', onGenerate);
  root.append(
    el(
      'section',
      { class: 'panel' },
      el('h2', { text: 'Blend a playlist' }),
      el('p', { id: 'gen-blurb', class: 'panel-sub', text: SOURCES[source].blurb }),
      genForm,
      el('div', { id: 'gen-result' })
    )
  );

  // --- History ---
  root.append(
    el('div', { class: 'section-head' }, el('h2', { text: 'Past blends' })),
    el('section', { id: 'history', class: 'panel' })
  );
  renderHistory();
}

function renderJoinPanel(root) {
  const panel = el('section', { class: 'panel join-panel' });
  panel.append(
    el('h2', { text: `Join “${room.name}”` }),
    el('p', {
      text:
        'Connect your Spotify account so your listening goes into the blend. ' +
        'Ronda only reads your recently played and most-played tracks.',
    })
  );
  if (!me) {
    panel.append(el('a', { class: 'btn btn-spotify btn-lg', href: loginJoinHref, text: 'Join with Spotify' }));
  } else {
    panel.append(
      el('button', {
        class: 'btn btn-primary btn-lg',
        text: 'Join this ronda',
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            ({ room } = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST' }));
            render();
            refreshTracks(false);
            toast(`You're in — welcome to ${room.name}!`, 'success');
          } catch (err) {
            toast(err.message, 'error');
            event.target.disabled = false;
          }
        },
      })
    );
  }
  root.append(panel);
}

function renderMemberSkeletons() {
  const grid = $('members-grid');
  grid.textContent = '';
  for (const member of room.members) {
    grid.append(memberCard(member, null, 'Loading their listens…'));
  }
}

function memberCard(member, tracks, note) {
  const head = el(
    'div',
    { class: 'member-head' },
    avatar(member),
    el(
      'div',
      { class: 'who' },
      el(
        'div',
        { class: 'name' },
        member.name,
        member.isYou ? el('span', { class: 'badge badge-you', text: 'you', style: 'margin-left:8px' }) : null
      ),
      member.needsReconnect
        ? el('span', { class: 'badge badge-warn', text: 'needs reconnect' })
        : el('div', { class: 'sub', text: 'listening on Spotify' })
    )
  );
  const card = el('div', { class: 'member-card' }, head);

  if (!tracks) {
    card.append(el('div', { class: 'member-empty', text: note ?? '' }));
    return card;
  }
  if (!tracks.length) {
    card.append(
      el('div', {
        class: 'member-empty',
        text: member.needsReconnect
          ? 'Their Spotify connection needs a refresh — ask them to log in to Ronda again.'
          : SOURCES[source].empty,
      })
    );
    return card;
  }
  card.append(
    el(
      'ul',
      { class: 'track-list' },
      tracks.map((track) =>
        el(
          'li',
          { class: 'track' },
          track.image
            ? el('img', { src: track.image, alt: '', loading: 'lazy' })
            : el('div', { class: 'art-fallback', text: '♪' }),
          el(
            'div',
            { class: 't-info' },
            el('div', { class: 't-name', text: track.name, title: track.name }),
            el('div', { class: 't-artist', text: track.artists, title: track.artists })
          ),
          el('span', {
            class: 't-when',
            text: track.rank ? `#${track.rank}` : timeAgo(track.playedAt),
          })
        )
      )
    )
  );
  return card;
}

/** Reflects the selected source in the heading and the blend panel's copy. */
function applySource() {
  const heading = $('source-heading');
  if (heading) heading.textContent = SOURCES[source].label;
  const blurb = $('gen-blurb');
  if (blurb) blurb.textContent = SOURCES[source].blurb;
}

async function refreshTracks(fresh) {
  const requested = source;
  const button = $('refresh-btn');
  if (button) {
    button.disabled = true;
    button.textContent = 'Refreshing…';
  }
  try {
    const query = new URLSearchParams({ source: requested });
    if (fresh) query.set('fresh', '1');
    const { members } = await api(
      `/api/rooms/${encodeURIComponent(roomId)}/tracks?${query}`
    );
    if (requested !== source) return; // the picker moved on while we were waiting
    const grid = $('members-grid');
    grid.textContent = '';
    let needsReconnect = false;
    for (const entry of members) {
      if (entry.error === 'needs_reconnect') needsReconnect = true;
      grid.append(
        entry.error
          ? memberCard(
              entry.member,
              null,
              entry.error === 'needs_reconnect'
                ? "Hasn't given Ronda permission to read this yet — they need to log in again."
                : "Couldn't read their listens right now — they may need to reconnect."
            )
          : memberCard(entry.member, entry.tracks, null)
      );
    }
    if (needsReconnect) showReconnect();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Refresh';
    }
  }
}

/** Reading top tracks needs a permission older logins never granted. */
function showReconnect() {
  const host = $('reconnect-notice');
  if (!host || host.childElementCount) return;
  host.append(
    el(
      'div',
      { class: 'notice' },
      el('div', {}, 'Ronda now needs permission to read most-played tracks. Log in again once to grant it.'),
      el('a', {
        class: 'btn btn-spotify btn-sm',
        href: `/auth/login?next=${encodeURIComponent(`/r/${roomId}`)}`,
        text: 'Reconnect Spotify',
      })
    )
  );
}

async function onGenerate(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = 'Blending…';
  try {
    const { playlist } = await api(`/api/rooms/${encodeURIComponent(roomId)}/playlist`, {
      method: 'POST',
      body: {
        source,
        limit: Number($('gen-limit').value),
        name: $('gen-name').value.trim() || undefined,
      },
    });
    room.playlists = [playlist, ...(room.playlists ?? [])];
    showGenResult(playlist);
    renderHistory();
    toast('Playlist created on your Spotify 🎉', 'success');
  } catch (err) {
    toast(err.message, 'error');
    if (err.code === 'needs_reconnect') showReconnect();
  } finally {
    button.disabled = false;
    button.textContent = 'Blend on Spotify';
  }
}

function showGenResult(playlist) {
  const result = $('gen-result');
  result.textContent = '';
  const box = el(
    'div',
    { class: 'gen-result' },
    el('div', { class: 'r-name', text: playlist.name }),
    el('div', {
      class: 'muted',
      style: 'font-size:14px;margin:4px 0 2px',
      text: `${playlist.trackCount} tracks · saved to your Spotify library`,
    }),
    el(
      'div',
      { class: 'chips' },
      playlist.contributions.map((c) => el('span', { class: 'chip', text: `${c.name} · ${c.count}` }))
    )
  );
  if (playlist.skippedMembers?.length) {
    box.append(
      el('div', {
        class: 'muted',
        style: 'font-size:13px;margin-top:10px',
        text: `Skipped (no readable listens right now): ${playlist.skippedMembers.join(', ')}`,
      })
    );
  }
  // The point of the whole flow — same shape as "Blend on Spotify", Spotify green.
  box.append(
    el('a', {
      class: 'btn btn-spotify r-open',
      href: playlist.url,
      target: '_blank',
      rel: 'noopener',
      text: 'Open Playlist',
    })
  );
  result.append(box);
}

function renderHistory() {
  const history = $('history');
  if (!history) return;
  history.textContent = '';
  const playlists = room.playlists ?? [];
  if (!playlists.length) {
    history.append(
      el('p', { class: 'muted', style: 'margin:0', text: 'Nothing yet — blend your first playlist above.' })
    );
    return;
  }
  for (const playlist of playlists) {
    history.append(
      el(
        'div',
        { class: 'playlist-row' },
        el(
          'div',
          {},
          el('div', { class: 'p-name', text: playlist.name }),
          el('div', {
            class: 'p-meta',
            text:
              `${playlist.trackCount} tracks · ${SOURCES[playlist.source]?.label ?? 'Latest listens'}` +
              ` · by ${playlist.createdBy} · ${timeAgo(playlist.createdAt)}`,
          })
        ),
        el('a', {
          class: 'btn btn-ghost btn-sm',
          href: playlist.url,
          target: '_blank',
          rel: 'noopener',
          text: 'Open ↗',
        })
      )
    );
  }
}

async function copyInvite() {
  const url = `${location.origin}/r/${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied — send it to your friends!', 'success');
  } catch {
    prompt('Copy this invite link:', url);
  }
}

main().catch((err) => {
  console.error(err);
  toast('Something went wrong loading the page.', 'error');
});
