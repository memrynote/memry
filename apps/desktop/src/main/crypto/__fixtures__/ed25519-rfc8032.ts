// Ed25519 (Ed25519ph context = none) golden vectors.
//
// Source: RFC 8032 §7.1 — Test Vectors for Ed25519
// URL:    https://datatracker.ietf.org/doc/html/rfc8032#section-7.1
// Retrieved: 2026-04-16
//
// libsodium's crypto_sign_seed_keypair / crypto_sign_detached implement the
// pure Ed25519 variant covered by these vectors. The 64-byte secret-key form
// libsodium emits is `seed || publicKey`; we store the seed alone here so
// signing tests can reconstruct the keypair via crypto_sign_seed_keypair.

import { assertEd25519Vector, hexToBytes, type Ed25519Vector } from './load-vectors'

// ---------------------------------------------------------------------------
// TEST 1 — empty message
// ---------------------------------------------------------------------------

const TEST1_SEED_HEX =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'

const TEST1_PUBLIC_KEY_HEX =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

const TEST1_MESSAGE_HEX = ''

const TEST1_SIGNATURE_HEX =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
  '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'

// Tamper sentinel: SHA-256 of `hexToBytes(TEST1_SIGNATURE_HEX)`. Pin via
// ./README.md → "Tamper sentinels" recipe on first consumer test run.
// SHA-256:

export const ED25519_RFC8032_TEST_1: Ed25519Vector = assertEd25519Vector({
  name: 'ed25519-rfc8032-test-1-empty',
  source: 'RFC 8032 §7.1 TEST 1',
  retrievedAt: '2026-04-16',
  secretKeySeed: hexToBytes(TEST1_SEED_HEX),
  publicKey: hexToBytes(TEST1_PUBLIC_KEY_HEX),
  message: hexToBytes(TEST1_MESSAGE_HEX),
  signature: hexToBytes(TEST1_SIGNATURE_HEX)
})

// ---------------------------------------------------------------------------
// TEST 2 — single-byte message 0x72
// ---------------------------------------------------------------------------

const TEST2_SEED_HEX =
  '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'

const TEST2_PUBLIC_KEY_HEX =
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'

const TEST2_MESSAGE_HEX = '72'

const TEST2_SIGNATURE_HEX =
  '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
  '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'

// Tamper sentinel: SHA-256 of `hexToBytes(TEST2_SIGNATURE_HEX)`. Pin via
// ./README.md → "Tamper sentinels" recipe on first consumer test run.
// SHA-256:

export const ED25519_RFC8032_TEST_2: Ed25519Vector = assertEd25519Vector({
  name: 'ed25519-rfc8032-test-2-single-byte',
  source: 'RFC 8032 §7.1 TEST 2',
  retrievedAt: '2026-04-16',
  secretKeySeed: hexToBytes(TEST2_SEED_HEX),
  publicKey: hexToBytes(TEST2_PUBLIC_KEY_HEX),
  message: hexToBytes(TEST2_MESSAGE_HEX),
  signature: hexToBytes(TEST2_SIGNATURE_HEX)
})

export const ED25519_RFC8032_VECTORS: readonly Ed25519Vector[] = [
  ED25519_RFC8032_TEST_1,
  ED25519_RFC8032_TEST_2
]
