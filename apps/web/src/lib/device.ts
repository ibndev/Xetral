/**
 * A stable per-browser device identifier.
 *
 * NOT a security control, and worth being explicit about because it looks like
 * one. The server binds a session to it and refuses a session opened on a
 * revoked device, so it needs to be consistent — but anyone can read it and
 * anyone can change it, and nothing is trusted on the strength of it. It is in
 * `localStorage` for exactly that reason: this is the one value on this app
 * that it is safe to keep there.
 */
const KEY = 'xetral_device';

export function deviceFingerprint(): string {
  let value = window.localStorage.getItem(KEY);
  if (value === null) {
    value = crypto.randomUUID();
    window.localStorage.setItem(KEY, value);
  }
  return value;
}
