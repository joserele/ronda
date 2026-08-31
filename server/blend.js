/**
 * Blend several members' recently-played lists into one playlist.
 *
 * Strategy: round-robin. Take each member's most recent track in turn, skip
 * anything already picked (within a member's own list or by another member),
 * and stop at `limit`. This keeps the result fair — everyone contributes
 * roughly equally — and fresh, since each member's newest listens go first.
 *
 * @param {Array<Array<{uri: string}>>} memberLists
 *   One array per member, each sorted most-recent-first. Items only need a
 *   `uri`; any extra fields are carried through untouched.
 * @param {{limit?: number}} [opts]
 * @returns {Array<object>} interleaved, deduplicated tracks (≤ limit)
 */
export function blendRecent(memberLists, opts = {}) {
  const limit = Math.max(1, opts.limit ?? 50);

  // Dedupe within each member's list first (repeat plays keep the most recent).
  const queues = memberLists.map((list) => {
    const seen = new Set();
    const queue = [];
    for (const item of list ?? []) {
      if (!item?.uri || seen.has(item.uri)) continue;
      seen.add(item.uri);
      queue.push(item);
    }
    return queue;
  });

  const out = [];
  const globalSeen = new Set();
  let pickedAny = true;
  while (out.length < limit && pickedAny) {
    pickedAny = false;
    for (const queue of queues) {
      while (queue.length) {
        const item = queue.shift();
        if (globalSeen.has(item.uri)) continue;
        globalSeen.add(item.uri);
        out.push(item);
        pickedAny = true;
        break;
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}
