'use strict';
// Minimal Keccak-256 (original Keccak padding, domain byte 0x01 — NOT SHA3-256).
// Pure JS with BigInt lanes; validated against known vectors in test/keccak.test.js.

const MASK64 = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y], lane index = x + 5*y.
const RHO = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

// Pi permutation target indices: lane (x,y) moves to (y, (2x+3y) mod 5).
const PI = new Array(25);
for (let x = 0; x < 5; x++) {
  for (let y = 0; y < 5; y++) {
    PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);
  }
}

function rotl(v, n) {
  if (n === 0) return v;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK64;
}

function keccakF(state) {
  const C = new Array(5);
  const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= d;
    }
    // rho + pi
    for (let i = 0; i < 25; i++) {
      B[PI[i]] = rotl(state[i], RHO[i]);
    }
    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] =
          B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK64) & B[((x + 2) % 5) + 5 * y]);
      }
    }
    // iota
    state[0] ^= RC[round];
  }
}

function keccak256(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const RATE = 136; // 1088 bits for Keccak-256
  const state = new Array(25).fill(0n);

  // pad10*1 with Keccak domain byte 0x01
  const padded = Buffer.alloc(Math.ceil((bytes.length + 1) / RATE) * RATE, 0);
  bytes.copy(padded, 0);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let v = 0n;
      for (let j = 7; j >= 0; j--) {
        v = (v << 8n) | BigInt(padded[off + lane * 8 + j]);
      }
      state[lane] ^= v;
    }
    keccakF(state);
  }

  const out = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane++) {
    let v = state[lane];
    for (let j = 0; j < 8; j++) {
      out[lane * 8 + j] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

function selector(signature) {
  return '0x' + keccak256(signature).subarray(0, 4).toString('hex');
}

module.exports = { keccak256, selector };
