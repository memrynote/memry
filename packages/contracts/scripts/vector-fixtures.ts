/**
 * Fixed inputs shared by the vector generators.
 *
 * Extracted from gen-crypto-vectors.ts so both generators draw the same
 * material and neither file outgrows the 300-line ceiling that
 * scripts/check-line-ceilings.mjs enforces.
 *
 * These are public parity fixtures, not secrets: they are committed on purpose
 * so both shells can byte-compare against them. Never reuse in production.
 */

/**
 * Mirrors apps/desktop/src/main/crypto/keys.ts KDF_CONTEXT_MAP — a second
 * implementation must reproduce these exact (ctx, id) pairs.
 */
export const KDF_CONTEXTS = [
  { name: 'memry-vault-key-v1', ctx: 'memryvlt', id: 1 },
  { name: 'memry-signing-key-v1', ctx: 'memrysgn', id: 2 },
  { name: 'memry-verify-key-v1', ctx: 'memryvrf', id: 3 },
  { name: 'memry-key-verifier-v1', ctx: 'memrykve', id: 4 },
  { name: 'memry-linking-enc-v1', ctx: 'memrylnk', id: 5 },
  { name: 'memry-linking-mac-v1', ctx: 'memrymac', id: 6 },
  { name: 'memry-linking-sas-v1', ctx: 'memrysas', id: 7 }
] as const

export const PARITY_PASSPHRASE_PROD = 'correct horse battery staple — memry parity'
export const PARITY_PASSPHRASE_SMOKE = 'memry-smoke'

export const SEED_A = 'a0'.repeat(32)
export const SEED_B = '5c'.repeat(32)
export const KEY_32_A = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'
export const KEY_32_B = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef'
export const NONCE_24_A = '000102030405060708090a0b0c0d0e0f1011121314151617'
export const NONCE_24_B = '17161514131211100f0e0d0c0b0a09080706050403020100'
