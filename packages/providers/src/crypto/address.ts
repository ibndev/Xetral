import { createHash } from 'node:crypto';
// '@noble/hashes/sha3.js', with the extension. The extensionless specifier
// exists in the package's export map but resolves only under CommonJS, so it
// compiles and then fails at import time — the same trap
// '@nestjs/common/constants' set in apps/api, and the same fix.
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { CryptoNetwork } from '../ports/crypto.js';

/**
 * Is this address plausibly real, on this chain?
 *
 * THE ONLY CONTROL THAT PREVENTS AN IRREVERSIBLE MISTAKE. A crypto withdrawal
 * to a mistyped address does not bounce — it delivers, to nobody or to a
 * stranger, permanently. There is no provider to call.
 *
 * So this does not merely check shape. Every format here carries a CHECKSUM,
 * and the checksum is the part that matters: it is what turns a single
 * transposed character from a lost balance into a rejected request. Length and
 * prefix checks alone would accept `TQ2n9F4kAbc...` with two digits swapped.
 *
 * What it deliberately does NOT claim: that the address exists, that anybody
 * controls it, or that it can receive this asset. Those are unknowable from
 * here. A caller must still show the customer what they typed and ask.
 */

export class InvalidAddressError extends Error {
  constructor(
    readonly network: CryptoNetwork,
    reason: string,
  ) {
    super(`not a valid ${network} address: ${reason}`);
    this.name = 'InvalidAddressError';
  }
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Throws `InvalidAddressError` rather than returning false, so a caller
 *  cannot forget to check the result on the one path where forgetting is
 *  unrecoverable. */
export function assertValidAddress(address: string, network: CryptoNetwork): void {
  const trimmed = address.trim();
  if (trimmed !== address) {
    // Pasted addresses collect whitespace. Rejecting rather than trimming
    // silently means the customer sees exactly what will be used.
    throw new InvalidAddressError(network, 'it has leading or trailing whitespace');
  }

  switch (network) {
    case 'tron':
      assertBase58Check(trimmed, network, 'T', 34);
      return;
    case 'bitcoin':
      assertBitcoin(trimmed);
      return;
    case 'ethereum':
    case 'bsc':
      assertEvm(trimmed, network);
      return;
  }
}

export function isValidAddress(address: string, network: CryptoNetwork): boolean {
  try {
    assertValidAddress(address, network);
    return true;
  } catch {
    return false;
  }
}

/**
 * Base58Check: the last four bytes are the first four of a double SHA-256 over
 * the rest. Used by Tron and by legacy Bitcoin addresses.
 */
function assertBase58Check(
  address: string,
  network: CryptoNetwork,
  prefix: string,
  length: number,
): void {
  if (!address.startsWith(prefix)) {
    throw new InvalidAddressError(network, `it does not begin with '${prefix}'`);
  }
  if (address.length !== length) {
    throw new InvalidAddressError(
      network,
      `it is ${address.length} characters, not ${length}`,
    );
  }
  assertChecksum(address, network);
}

function assertChecksum(address: string, network: CryptoNetwork): void {
  let decoded: Buffer;
  try {
    decoded = base58Decode(address);
  } catch {
    throw new InvalidAddressError(network, 'it contains characters base58 does not use');
  }

  if (decoded.length < 5) {
    throw new InvalidAddressError(network, 'it is too short to carry a checksum');
  }

  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = sha256(sha256(payload)).subarray(0, 4);

  if (!checksum.equals(expected)) {
    // The message says what this means, because it is the one a customer sees
    // after mistyping one character of an address they were about to send
    // money to for ever.
    throw new InvalidAddressError(
      network,
      'its checksum does not match — it is probably mistyped',
    );
  }
}

function assertBitcoin(address: string): void {
  if (address.startsWith('bc1')) {
    // Bech32. The checksum is a BCH code over the data part; validating it
    // properly needs the polymod below.
    assertBech32(address);
    return;
  }
  if (address.startsWith('1') || address.startsWith('3')) {
    if (address.length < 26 || address.length > 35) {
      throw new InvalidAddressError('bitcoin', `it is ${address.length} characters`);
    }
    assertChecksum(address, 'bitcoin');
    return;
  }
  throw new InvalidAddressError('bitcoin', "it does not begin with '1', '3' or 'bc1'");
}

/**
 * EIP-55: an all-lowercase or all-uppercase address carries no checksum and is
 * accepted on shape alone. A MIXED-CASE one does carry one, and a mismatch
 * means the address was altered or mistyped — so mixed case is checked, which
 * is exactly the case wallets produce.
 */
function assertEvm(address: string, network: CryptoNetwork): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new InvalidAddressError(network, 'it is not 0x followed by 40 hex characters');
  }

  const body = address.slice(2);
  const isMixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (!isMixedCase) return;

  if (body !== eip55(body.toLowerCase())) {
    throw new InvalidAddressError(
      network,
      'its EIP-55 checksum does not match — it is probably mistyped',
    );
  }
}

function eip55(lowercaseBody: string): string {
  const hash = keccak256(Buffer.from(lowercaseBody, 'ascii')).toString('hex');
  let out = '';
  for (let i = 0; i < lowercaseBody.length; i += 1) {
    const char = lowercaseBody[i] ?? '';
    const nibble = Number.parseInt(hash[i] ?? '0', 16);
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/* ---------------------------------------------------------------------- */

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

function base58Decode(input: string): Buffer {
  let num = 0n;
  for (const char of input) {
    const index = BASE58.indexOf(char);
    if (index === -1) throw new Error('not base58');
    num = num * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  // Leading '1's are leading zero bytes, and they are part of the payload the
  // checksum covers.
  for (const char of input) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function assertBech32(address: string): void {
  const lower = address.toLowerCase();
  if (lower !== address && address.toUpperCase() !== address) {
    throw new InvalidAddressError('bitcoin', 'bech32 addresses are not mixed case');
  }

  const separator = lower.lastIndexOf('1');
  if (separator < 1) throw new InvalidAddressError('bitcoin', 'it has no separator');

  const hrp = lower.slice(0, separator);
  const dataPart = lower.slice(separator + 1);
  if (dataPart.length < 6) throw new InvalidAddressError('bitcoin', 'its data part is too short');

  const data: number[] = [];
  for (const char of dataPart) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index === -1) {
      throw new InvalidAddressError('bitcoin', 'it contains characters bech32 does not use');
    }
    data.push(index);
  }

  const checksum = polymod([...hrpExpand(hrp), ...data]);
  // 1 is bech32 (SegWit v0); 0x2bc830a3 is bech32m (v1+, taproot). Both are
  // real bitcoin addresses a customer may paste.
  if (checksum !== 1 && checksum !== 0x2bc830a3) {
    throw new InvalidAddressError(
      'bitcoin',
      'its checksum does not match — it is probably mistyped',
    );
  }
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

function polymod(values: readonly number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= (GEN[i] ?? 0);
    }
  }
  return chk >>> 0;
}

/**
 * Keccak-256, needed for EIP-55 and NOT the same as SHA3-256 — Node's
 * `sha3-256` uses the standardised padding and produces a different digest.
 * Getting that wrong would reject every correctly checksummed address.
 */
/**
 * Keccak-256, from @noble/hashes.
 *
 * NOT hand-rolled, and not Node's `sha3-256` either. The first attempt here
 * was a hand-written permutation: it produced plausible-looking digests, and
 * every known-answer vector rejected it. Rolling a hash by hand in a codebase
 * that moves money is not a saving, and the failure mode — an EIP-55 check
 * that rejects every correctly checksummed address, or worse accepts a
 * mistyped one — is exactly the kind that reaches production looking fine.
 *
 * Node's built-in `sha3-256` is a different function: it uses the
 * standardised 0x06 padding where Keccak uses 0x01, so it returns a different
 * digest for the same input and would silently break EIP-55.
 */
export function keccak256ForTest(input: string): string {
  return Buffer.from(keccak_256(Buffer.from(input, 'ascii'))).toString('hex');
}

function keccak256(input: Buffer): Buffer {
  return Buffer.from(keccak_256(input));
}
