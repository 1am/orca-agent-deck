import { createHash } from 'node:crypto';

/**
 * Short, deterministic ASCII ids for paneKeys (`tabId:leafId`), for humans and dev tools.
 * Hash-based so an id stays the same across restarts; length grows only on collision.
 */
export function shortIds(paneKeys: string[], minLen = 3): Map<string, string> {
  const hashes = paneKeys.map((k) => ({
    k,
    h: BigInt('0x' + createHash('sha1').update(k).digest('hex')).toString(36),
  }));
  for (let len = minLen; len <= 12; len++) {
    const ids = new Set(hashes.map((x) => x.h.slice(0, len)));
    if (ids.size === new Set(paneKeys).size) {
      return new Map(hashes.map((x) => [x.k, x.h.slice(0, len)]));
    }
  }
  return new Map(hashes.map((x) => [x.k, x.h]));
}
