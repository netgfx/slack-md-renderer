/**
 * @file Short-lived in-memory cache for audited source, keyed by an opaque token
 * (§4b.4). Lets the "Download as HTML" action reuse the already-audited bytes
 * without re-fetching. Entries expire so memory stays bounded; this is a
 * single-instance convenience, not durable storage.
 */

import { randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const store = new Map(); // token -> { value, expires }

/**
 * Store a value and return its token.
 * @param {any} value
 * @returns {string} token
 */
export function put(value) {
  sweep();
  const token = randomBytes(16).toString('hex');
  store.set(token, { value, expires: Date.now() + TTL_MS });
  return token;
}

/**
 * Retrieve a value by token, or null if missing/expired.
 * @param {string} token
 * @returns {any|null}
 */
export function get(token) {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    store.delete(token);
    return null;
  }
  return entry.value;
}

/** Drop a token early (e.g. after a successful download). @param {string} token */
export function drop(token) {
  store.delete(token);
}

function sweep() {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expires < now) store.delete(token);
  }
}
