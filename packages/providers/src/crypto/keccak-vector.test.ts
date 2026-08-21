import { describe, expect, it } from 'vitest';
import { keccak256ForTest } from './address.js';

/** Known Keccak-256 vectors. If these fail, EIP-55 validation is worthless —
 *  and note SHA3-256 gives DIFFERENT answers, which is the trap. */
describe('keccak-256', () => {
  it('hashes the empty string', () => {
    expect(keccak256ForTest('')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });

  it('hashes abc', () => {
    expect(keccak256ForTest('abc')).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
  });
});
