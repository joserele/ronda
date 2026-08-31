// Shared helpers for Ronda's pages: API wrapper, DOM builder, header, toasts.

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

/** Tiny DOM builder — children are appended, strings become text nodes (XSS-safe). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function initials(name = '?') {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function avatar(user, size = '') {
  const cls = `avatar ${size}`.trim();
  return user.avatarUrl
    ? el('img', { class: cls, src: user.avatarUrl, alt: '', referrerpolicy: 'no-referrer' })
    : el('div', { class: `${cls} avatar-fallback`, text: initials(user.name) });
}

export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast toast-${kind}`, text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 300);
  }, 3800);
}

/** Fills the header's auth area with either a Connect button or the user chip. */
export function renderHeader(user, loginHref = '/auth/login') {
  const area = document.getElementById('auth-area');
  if (!area) return;
  area.textContent = '';
  if (!user) {
    area.append(el('a', { class: 'btn btn-spotify btn-sm', href: loginHref, text: 'Connect Spotify' }));
    return;
  }
  area.append(
    el(
      'div',
      { class: 'user-chip' },
      avatar(user, 'avatar-sm'),
      el('span', { class: 'user-name', text: user.name }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Log out',
        onclick: async () => {
          try {
            await api('/auth/logout', { method: 'POST' });
          } finally {
            location.href = '/';
          }
        },
      })
    )
  );
}
