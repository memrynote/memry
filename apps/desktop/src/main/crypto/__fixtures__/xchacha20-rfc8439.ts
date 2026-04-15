// XChaCha20-Poly1305 golden vectors.
//
// Source: draft-irtf-cfrg-xchacha-03 §A.3.1 (XChaCha20-Poly1305 AEAD)
// URL:    https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1
// Retrieved: 2026-04-16
//
// The IETF Poly1305 construction used here is the same one referenced by
// RFC 8439 §2.8 — XChaCha20 extends the nonce to 24 bytes via HChaCha20.
// libsodium exposes this exact construction as
// crypto_aead_xchacha20poly1305_ietf_encrypt / _decrypt.
//
// Tag identity: the AEAD output concatenates ciphertext || tag(16). The split
// below stores them separately so tests can assert each half independently.

import { assertXChaCha20Vector, hexToBytes, type XChaCha20Vector } from './load-vectors'

// Plaintext: ASCII "Ladies and Gentlemen of the class of '99: If I could offer
// you only one tip for the future, sunscreen would be it." (114 bytes)
const PLAINTEXT_HEX =
  '4c616469657320616e642047656e746c656d656e206f662074686520636c6173' +
  '73206f66202739393a204966204920636f756c64206f6666657220796f75206f' +
  '6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73' +
  '637265656e20776f756c642062652069742e'

// AAD: 50 51 52 53 c0 c1 c2 c3 c4 c5 c6 c7
const AAD_HEX = '50515253c0c1c2c3c4c5c6c7'

// Key: 80 81 82 ... 9f (32 bytes, monotonically increasing)
const KEY_HEX = '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'

// Nonce: 40 41 42 ... 57 (24 bytes, monotonically increasing)
const NONCE_HEX = '404142434445464748494a4b4c4d4e4f5051525354555657'

// Ciphertext (114 bytes) and Poly1305 tag (16 bytes) per the draft's
// "Resulting ciphertext" section.
const CIPHERTEXT_HEX =
  'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
  '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
  '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
  '21f9664c97637da9768812f615c68b13b52e'

const TAG_HEX = 'c0875924c1c7987947deafd8780acf49'

// Tamper sentinel: SHA-256 of `hexToBytes(CIPHERTEXT_HEX + TAG_HEX)`.
// Pin the value on first consumer test run via ./README.md → "Tamper
// sentinels" recipe; until then this comment intentionally stays empty so a
// stale hash never silently masks a real edit.
// SHA-256:

export const XCHACHA20_RFC8439_DRAFT_VECTOR: XChaCha20Vector = assertXChaCha20Vector({
  name: 'xchacha20-poly1305-ietf-draft-A.3.1',
  source: 'draft-irtf-cfrg-xchacha-03 §A.3.1',
  retrievedAt: '2026-04-16',
  key: hexToBytes(KEY_HEX),
  nonce: hexToBytes(NONCE_HEX),
  aad: hexToBytes(AAD_HEX),
  plaintext: hexToBytes(PLAINTEXT_HEX),
  ciphertext: hexToBytes(CIPHERTEXT_HEX),
  tag: hexToBytes(TAG_HEX)
})

export const XCHACHA20_RFC8439_VECTORS: readonly XChaCha20Vector[] = [
  XCHACHA20_RFC8439_DRAFT_VECTOR
]
