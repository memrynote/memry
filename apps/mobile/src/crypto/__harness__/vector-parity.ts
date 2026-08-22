/**
 * On-device crypto vector parity harness (spec 001-mobile-app T008 / G0-a).
 *
 * Runs every fixture in @memry/contracts test-vectors/crypto-vectors.json
 * through the JSI binding (react-native-libsodium + scalarmult patch) and
 * byte-compares against the desktop-generated expectations.
 *
 * PASS = byte parity on every vector — expected output `PARITY OK <n>/<n>`.
 * Any mismatch = R1 FAIL: stop the train, follow research.md §R1's fallback
 * ladder. Run from a dev screen on the physical reference device (release
 * build for the Argon2id 64 MiB memory-pressure check).
 */
import sodium from 'react-native-libsodium'

import vectors from '@memry/contracts/test-vectors/crypto-vectors.json'

export interface ParityResult {
  name: string
  ok: boolean
  detail?: string
}

export interface ParityReport {
  passed: number
  total: number
  ok: boolean
  summary: string
  results: ParityResult[]
}

const hexToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

const bytesToHex = (bytes: Uint8Array): string => sodium.to_hex(bytes)

const utf8 = (value: string): Uint8Array => {
  // TextEncoder is native under Hermes V1 (SDK 56+).
  return new TextEncoder().encode(value)
}

// The JSI binding accepts associated data only as a string; vectors carry AD
// as hex over ASCII bytes, decoded here. Binary (non-ASCII) AD is unsupported
// by the binding — acceptable: vault payloads never use binary AD.
const hexToAsciiString = (value: string): string => {
  const bytes = hexToBytes(value)
  let out = ''
  for (const byte of bytes) {
    if (byte > 0x7f) {
      throw new Error('non-ASCII associated data is unsupported by the JSI binding')
    }
    out += String.fromCharCode(byte)
  }
  return out
}

export const runVectorParity = async (): Promise<ParityReport> => {
  await sodium.ready
  const results: ParityResult[] = []
  const check = (name: string, actual: string, expected: string): void => {
    results.push(
      actual === expected
        ? { name, ok: true }
        : { name, ok: false, detail: `expected ${expected}, got ${actual}` }
    )
  }

  // Argon2id — production params (64 MiB / ops 3) and the smoke vector.
  for (const v of vectors.argon2id) {
    const derived = sodium.crypto_pwhash(
      v.outLength,
      utf8(v.passwordUtf8),
      hexToBytes(v.saltHex),
      v.opsLimit,
      v.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
    check(`argon2id: ${v.description}`, bytesToHex(derived), v.derivedHex)
  }

  // XChaCha20-Poly1305 IETF — encrypt to expected ciphertext, then open it.
  for (const v of vectors.xchacha20poly1305Ietf) {
    const plaintext =
      'plaintextUtf8' in v && v.plaintextUtf8
        ? utf8(v.plaintextUtf8)
        : hexToBytes(v.plaintextHex ?? '')
    const ad = v.adHex ? hexToAsciiString(v.adHex) : ''
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      ad,
      null,
      hexToBytes(v.nonceHex),
      hexToBytes(v.keyHex)
    )
    check(`aead encrypt: ${v.description}`, bytesToHex(ciphertext), v.ciphertextHex)

    const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      hexToBytes(v.ciphertextHex),
      ad,
      hexToBytes(v.nonceHex),
      hexToBytes(v.keyHex)
    )
    check(`aead decrypt: ${v.description}`, bytesToHex(opened), bytesToHex(plaintext))
  }

  // Ed25519 seed keypair + detached signature + deviceId derivation.
  {
    const v = vectors.ed25519
    const pair = sodium.crypto_sign_seed_keypair(hexToBytes(v.seedHex))
    check('ed25519 publicKey', bytesToHex(pair.publicKey), v.publicKeyHex)
    check('ed25519 secretKey', bytesToHex(pair.privateKey), v.secretKeyHex)
    const signature = sodium.crypto_sign_detached(utf8(v.messageUtf8), pair.privateKey)
    check('ed25519 detached signature', bytesToHex(signature), v.detachedSignatureHex)
    results.push({
      name: 'ed25519 verify',
      ok: sodium.crypto_sign_verify_detached(
        hexToBytes(v.detachedSignatureHex),
        utf8(v.messageUtf8),
        pair.publicKey
      )
    })
    check(
      'deviceId derivation',
      sodium.to_hex(sodium.crypto_generichash(16, pair.publicKey, null)),
      v.deviceIdHex
    )
  }

  // crypto_kdf_derive_from_key — all 7 production contexts.
  for (const v of vectors.kdfDeriveFromKey) {
    const derived = sodium.crypto_kdf_derive_from_key(
      v.length,
      v.subkeyId,
      v.ctx,
      hexToBytes(v.masterKeyHex)
    )
    check(`kdf ${v.ctx}#${v.subkeyId}`, bytesToHex(derived), v.derivedHex)
  }

  // generichash — keyed + custom lengths.
  for (const v of vectors.generichash) {
    const message =
      'messageUtf8' in v && v.messageUtf8 ? utf8(v.messageUtf8) : hexToBytes(v.messageHex ?? '')
    const hash = sodium.crypto_generichash(
      v.outLength,
      message,
      v.keyHex ? hexToBytes(v.keyHex) : null
    )
    check(`generichash: ${v.description}`, bytesToHex(hash), v.hashHex)
  }

  // crypto_auth.
  for (const v of vectors.auth) {
    const mac = sodium.crypto_auth(utf8(v.messageUtf8), hexToBytes(v.keyHex))
    check('crypto_auth', bytesToHex(mac), v.macHex)
    results.push({
      name: 'crypto_auth_verify',
      ok: sodium.crypto_auth_verify(hexToBytes(v.macHex), utf8(v.messageUtf8), hexToBytes(v.keyHex))
    })
  }

  // crypto_scalarmult — the patched primitive (T007).
  for (const v of vectors.scalarmult.base) {
    check(
      'scalarmult_base',
      bytesToHex(sodium.crypto_scalarmult_base(hexToBytes(v.scalarHex))),
      v.publicKeyHex
    )
  }
  for (const v of vectors.scalarmult.shared) {
    check(
      'scalarmult shared secret',
      bytesToHex(sodium.crypto_scalarmult(hexToBytes(v.scalarHex), hexToBytes(v.pointHex))),
      v.sharedSecretHex
    )
  }

  // Box keypair public-key derivation.
  check(
    'box keypair derivation',
    bytesToHex(sodium.crypto_scalarmult_base(hexToBytes(vectors.boxKeypair.secretKeyHex))),
    vectors.boxKeypair.publicKeyHex
  )

  // Full vault-unlock flow: password → Argon2id → verifier → vault key →
  // unwrap file key → open body. Plaintext byte-equality here is the same
  // evidence as the G0-e SHA-256 comparison (hash equality follows from it).
  {
    const v = vectors.vaultUnlockFlow
    const masterKey = sodium.crypto_pwhash(
      32,
      utf8(v.passwordUtf8),
      hexToBytes(v.kdfSaltHex),
      v.argon2.opsLimit,
      v.argon2.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
    check('unlock: masterKey', bytesToHex(masterKey), v.masterKeyHex)

    const verifierKey = sodium.crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey)
    check(
      'unlock: keyVerifier',
      sodium.to_base64(verifierKey, sodium.base64_variants.ORIGINAL),
      v.keyVerifierBase64
    )

    const vaultKey = sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey)
    check('unlock: vaultKey', bytesToHex(vaultKey), v.vaultKeyHex)

    const fileKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      hexToBytes(v.encryptedKeyHex),
      '',
      hexToBytes(v.keyNonceHex),
      vaultKey
    )
    check('unlock: fileKey', bytesToHex(fileKey), v.fileKeyHex)

    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      hexToBytes(v.encryptedDataHex),
      '',
      hexToBytes(v.dataNonceHex),
      fileKey
    )
    check(
      'unlock: plaintext markdown',
      bytesToHex(plaintext),
      bytesToHex(utf8(v.plaintextMarkdownUtf8))
    )
  }

  const passed = results.filter((r) => r.ok).length
  const ok = passed === results.length
  return {
    passed,
    total: results.length,
    ok,
    summary: ok
      ? `PARITY OK ${passed}/${results.length} vectors`
      : `PARITY FAIL ${passed}/${results.length} — ${results
          .filter((r) => !r.ok)
          .map((r) => `${r.name}: ${r.detail ?? 'mismatch'}`)
          .join('; ')}`,
    results
  }
}
