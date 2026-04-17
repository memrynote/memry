// Argon2id golden vectors.
//
// Source: RFC 9106 §5.3 — Argon2id Test Vectors
// URL:    https://datatracker.ietf.org/doc/html/rfc9106#section-5.3
// Retrieved: 2026-04-16
//
// Parameter glossary (per RFC 9106 §3.1):
//   - parallelism (p): degree of parallelism (number of lanes)
//   - tagLength   (T): output length in bytes
//   - memoryKiB   (m): memory size in kibibytes
//   - iterations  (t): number of passes
//   - version     (v): Argon2 version number — 0x13 (= 19) for current spec
//
// Memry's runtime instantiation differs (memory = 64 MiB, ops = 3,
// parallelism = 1 because libsodium's crypto_pwhash hardcodes p=1). These
// vectors validate the underlying primitive against the RFC reference; tests
// that exercise libsodium's crypto_pwhash directly cannot reuse them without
// matching p. Cross-implementation verification (e.g., via @noble/hashes
// argon2id) is the recommended consumer.

import { assertArgon2idVector, hexToBytes, type Argon2idVector } from './load-vectors'

// Inputs per RFC 9106 §5.3:
//   Password:        0x01 repeated 32 times
//   Salt:            0x02 repeated 16 times
//   Secret value:    0x03 repeated 8 times
//   Associated data: 0x04 repeated 12 times
//   parallelism = 4, tagLength = 32, memory = 32 KiB, iterations = 3,
//   version = 0x13

const PASSWORD_HEX = '01'.repeat(32)
const SALT_HEX = '02'.repeat(16)
const SECRET_HEX = '03'.repeat(8)
const ASSOCIATED_DATA_HEX = '04'.repeat(12)

// Expected output tag (32 bytes) per RFC 9106 §5.3 final hash.
const TAG_HEX = '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659'

// Tamper sentinel: SHA-256 of `hexToBytes(TAG_HEX)`. Pin via ./README.md →
// "Tamper sentinels" recipe on first consumer test run.
// SHA-256:

export const ARGON2ID_RFC9106_VECTOR: Argon2idVector = assertArgon2idVector({
  name: 'argon2id-rfc9106-section-5.3',
  source: 'RFC 9106 §5.3',
  retrievedAt: '2026-04-16',
  password: hexToBytes(PASSWORD_HEX),
  salt: hexToBytes(SALT_HEX),
  secret: hexToBytes(SECRET_HEX),
  associatedData: hexToBytes(ASSOCIATED_DATA_HEX),
  parallelism: 4,
  tagLength: 32,
  memoryKiB: 32,
  iterations: 3,
  version: 0x13,
  tag: hexToBytes(TAG_HEX)
})

export const ARGON2ID_RFC9106_VECTORS: readonly Argon2idVector[] = [ARGON2ID_RFC9106_VECTOR]
