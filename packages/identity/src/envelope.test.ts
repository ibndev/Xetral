import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EnvelopeError, type Keyring, needsReseal, open, seal } from './envelope.js';

const v1 = { version: 'v1', key: randomBytes(32) };
const v2 = { version: 'v2', key: randomBytes(32) };

const keyring: Keyring = { current: v1, accepted: [v1] };
const BVN = '22345678901';

describe('sealing and opening', () => {
  it('round-trips', () => {
    expect(open(seal(BVN, keyring), keyring)).toBe(BVN);
  });

  it('carries the key version as a readable prefix', () => {
    // Rotation is only possible if every stored value announces which key
    // opened it. Retrofitting that onto bare ciphertext means guessing.
    expect(seal(BVN, keyring).startsWith('v1:')).toBe(true);
  });

  it('never produces the same ciphertext twice', () => {
    // A fresh IV per message. Equal ciphertexts would leak that two customers
    // share a BVN without decrypting anything.
    expect(seal(BVN, keyring)).not.toBe(seal(BVN, keyring));
  });

  it('handles unicode and empty strings', () => {
    expect(open(seal('', keyring), keyring)).toBe('');
    expect(open(seal('Adéwálé ₦1,000', keyring), keyring)).toBe('Adéwálé ₦1,000');
  });
});

describe('tampering', () => {
  it('rejects an edited ciphertext instead of returning different plaintext', () => {
    // The reason for GCM over CBC. Under CBC an attacker with database write
    // access can flip bits and decryption still "succeeds".
    const envelope = seal(BVN, keyring);
    const parts = envelope.split(':');
    const ct = Buffer.from(parts[3] ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0x01;

    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString('base64url')}`;
    expect(() => open(tampered, keyring)).toThrow(EnvelopeError);
  });

  it('rejects a ciphertext relabelled under another key version', () => {
    // The version is authenticated as additional data, so moving a v1 payload
    // into a v2 envelope fails the tag rather than silently decrypting.
    const envelope = seal(BVN, keyring);
    const both: Keyring = { current: v2, accepted: [v1, v2] };
    expect(() => open(envelope.replace(/^v1:/, 'v2:'), both)).toThrow(EnvelopeError);
  });

  it('rejects a swapped IV', () => {
    const a = seal(BVN, keyring).split(':');
    const b = seal('other value', keyring).split(':');
    expect(() => open(`${a[0]}:${b[1]}:${a[2]}:${a[3]}`, keyring)).toThrow(EnvelopeError);
  });

  it('rejects malformed input without throwing something unexpected', () => {
    for (const bad of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d', 'not-an-envelope']) {
      expect(() => open(bad, keyring)).toThrow(EnvelopeError);
    }
  });
});

describe('key rotation', () => {
  it('opens old data with a retired key that is still accepted', () => {
    const sealedUnderV1 = seal(BVN, keyring);
    const during: Keyring = { current: v2, accepted: [v2, v1] };

    expect(open(sealedUnderV1, during)).toBe(BVN);
    expect(seal(BVN, during).startsWith('v2:')).toBe(true);
  });

  it('says plainly which key is missing once one is dropped', () => {
    const sealedUnderV1 = seal(BVN, keyring);
    const after: Keyring = { current: v2, accepted: [v2] };
    expect(() => open(sealedUnderV1, after)).toThrow(/no key for envelope version 'v1'/);
  });

  it('identifies values still sealed under an old key', () => {
    const sealedUnderV1 = seal(BVN, keyring);
    const during: Keyring = { current: v2, accepted: [v2, v1] };
    expect(needsReseal(sealedUnderV1, during)).toBe(true);
    expect(needsReseal(seal(BVN, during), during)).toBe(false);
  });
});

describe('key validation', () => {
  it('rejects a key of the wrong length', () => {
    const short: Keyring = { current: { version: 'v1', key: randomBytes(16) }, accepted: [] };
    expect(() => seal(BVN, short)).toThrow(/32-byte key/);
  });

  it('rejects a version that is not a rotation marker', () => {
    const bad: Keyring = { current: { version: 'prod', key: randomBytes(32) }, accepted: [] };
    expect(() => seal(BVN, bad)).toThrow(/key version/);
  });
});
