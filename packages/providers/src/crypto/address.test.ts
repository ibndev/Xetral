import { describe, expect, it } from 'vitest';
import { assertValidAddress, InvalidAddressError, isValidAddress } from './address.js';

/**
 * The addresses below are REAL, well-known public addresses, used because a
 * made-up string cannot exercise a checksum. Nothing is ever sent to them;
 * they are here so the validator is tested against the thing it will actually
 * see rather than against a fixture built by the same reasoning as the code.
 */

// Binance's published Tron hot wallet.
const TRON_OK = 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9';
// Bitcoin genesis block coinbase output.
const BTC_LEGACY_OK = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
// A well-known bech32 (SegWit v0) address.
const BTC_BECH32_OK = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
// Vitalik Buterin's public address, EIP-55 checksummed.
const ETH_OK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('tron', () => {
  it('accepts a real address', () => {
    expect(isValidAddress(TRON_OK, 'tron')).toBe(true);
  });

  it('rejects one with a single transposed character', () => {
    // THE case that matters. A length-and-prefix check would accept this, and
    // the money would be gone for ever.
    const typo = `TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY8`;
    expect(isValidAddress(typo, 'tron')).toBe(false);
  });

  it('says the checksum is why', () => {
    try {
      assertValidAddress('TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY8', 'tron');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/mistyped/);
    }
  });

  it('rejects an Ethereum address offered as Tron', () => {
    // Sending USDT to the right string on the wrong chain loses it.
    expect(isValidAddress(ETH_OK, 'tron')).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isValidAddress('TMuA6YqfCeX8EhbfYEg5y7S4DqzSJire', 'tron')).toBe(false);
  });

  it('rejects base58-illegal characters', () => {
    // 0, O, I and l are excluded from base58 precisely because they are the
    // characters people confuse.
    expect(isValidAddress('TMuA6YqfCeX8EhbfYEg5y7S4DqzSJire0O', 'tron')).toBe(false);
  });
});

describe('bitcoin', () => {
  it('accepts a legacy address', () => {
    expect(isValidAddress(BTC_LEGACY_OK, 'bitcoin')).toBe(true);
  });

  it('accepts a bech32 address', () => {
    expect(isValidAddress(BTC_BECH32_OK, 'bitcoin')).toBe(true);
  });

  it('rejects a legacy address with a bad checksum', () => {
    expect(isValidAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'bitcoin')).toBe(false);
  });

  it('rejects a bech32 address with a bad checksum', () => {
    expect(isValidAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx', 'bitcoin')).toBe(false);
  });

  it('rejects a mixed-case bech32 address', () => {
    // The spec forbids it, and a mixed-case one is a sign of mangling.
    expect(isValidAddress('bc1Qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bitcoin')).toBe(false);
  });

  it('rejects something from another chain', () => {
    expect(isValidAddress(TRON_OK, 'bitcoin')).toBe(false);
  });
});

describe('ethereum and bsc', () => {
  it('accepts an EIP-55 checksummed address', () => {
    expect(isValidAddress(ETH_OK, 'ethereum')).toBe(true);
    // Same address format on BSC — the chains share it, which is exactly why
    // `network` is recorded separately on every transfer.
    expect(isValidAddress(ETH_OK, 'bsc')).toBe(true);
  });

  it('accepts an all-lowercase address', () => {
    // No checksum is carried, so there is nothing to verify and rejecting it
    // would refuse addresses many tools still produce.
    expect(isValidAddress(ETH_OK.toLowerCase(), 'ethereum')).toBe(true);
  });

  it('rejects a mixed-case address whose checksum does not match', () => {
    // One character's case flipped. This is what a mangled copy-paste looks
    // like, and EIP-55 exists to catch it.
    const flipped = `0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045`;
    expect(isValidAddress(flipped, 'ethereum')).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isValidAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA960', 'ethereum')).toBe(false);
  });

  it('rejects one with no 0x prefix', () => {
    expect(isValidAddress(ETH_OK.slice(2), 'ethereum')).toBe(false);
  });
});

describe('what it refuses everywhere', () => {
  it('rejects surrounding whitespace rather than trimming it', () => {
    // Pasted addresses collect whitespace. Refusing means the customer sees
    // exactly the string that will be used.
    expect(isValidAddress(` ${TRON_OK}`, 'tron')).toBe(false);
    expect(isValidAddress(`${TRON_OK} `, 'tron')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidAddress('', 'tron')).toBe(false);
    expect(isValidAddress('', 'bitcoin')).toBe(false);
    expect(isValidAddress('', 'ethereum')).toBe(false);
  });

  it('throws a typed error naming the chain', () => {
    try {
      assertValidAddress('nonsense', 'tron');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAddressError);
      expect((error as InvalidAddressError).network).toBe('tron');
    }
  });
});
