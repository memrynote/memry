/**
 * Self-contained fixtures for encryption.test.ts boundary + golden cases.
 *
 * IETF golden vector source: draft-irtf-cfrg-xchacha-03, Appendix A.3.1
 *   https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1
 *
 * The vector pins XChaCha20-Poly1305-IETF AEAD output for a known
 * (key, nonce, AAD, plaintext) tuple. Any drift in libsodium's primitive
 * or our parameter wiring (nonce length, key length, AEAD variant) will
 * cause the deterministic ciphertext assertion to fail.
 */

const fromHex = (hex: string): Uint8Array => {
  const stripped = hex.replace(/\s+/g, '')
  if (stripped.length % 2 !== 0) {
    throw new Error(`Hex string must have even length, got ${stripped.length}`)
  }
  const bytes = new Uint8Array(stripped.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export const IETF_XCHACHA20_POLY1305_VECTOR = {
  key: fromHex('808182838485868788898a8b8c8d8e8f' + '909192939495969798999a9b9c9d9e9f'),
  nonce: fromHex('404142434445464748494a4b4c4d4e4f5051525354555657'),
  aad: fromHex('50515253c0c1c2c3c4c5c6c7'),
  plaintext: fromHex(
    '4c616469657320616e642047656e746c656d656e206f662074686520636c6173' +
      '73206f66202739393a204966204920636f756c64206f6666657220796f75206f' +
      '6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73' +
      '637265656e20776f756c642062652069742e'
  ),
  ciphertext: fromHex(
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
      '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
      '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
      '21f9664c97637da9768812f615c68b13b52e' +
      'c0875924c1c7987947deafd8780acf49'
  )
} as const

export const ONE_MIB_PLUS_ONE = 1024 * 1024 + 1

export const buildPatternedPayload = (length: number): Uint8Array => {
  const buffer = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    buffer[i] = (i * 31 + 7) & 0xff
  }
  return buffer
}
