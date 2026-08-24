/**
 * Crypto vector generator for mobile byte-parity (spec 001-mobile-app, T005 / R1).
 *
 * Emits packages/contracts/test-vectors/crypto-vectors.json covering every
 * primitive the vault crypto uses (record §6): Argon2id at the exact production
 * params, XChaCha20-Poly1305 AEAD, Ed25519 seed keypair + detached sign,
 * crypto_kdf_derive_from_key (all 7 production contexts), keyed/custom-length
 * generichash, crypto_auth, crypto_scalarmult(+base), box keypair derivation,
 * and the full vault-unlock flow (password → Argon2id → KDF contexts →
 * verifier → wrapped file key → AEAD open).
 *
 * All inputs are fixed constants so the file is deterministic and committable.
 * Run: npx tsx packages/contracts/scripts/gen-crypto-vectors.ts
 * Proof suite: packages/contracts/src/__tests__/crypto-vectors.test.ts
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sodium from 'libsodium-wrappers-sumo'

import { ARGON2_PARAMS, XCHACHA20_PARAMS } from '../src/crypto'

// Mirrors apps/desktop/src/main/crypto/keys.ts KDF_CONTEXT_MAP — the mobile
// binding must reproduce these exact (ctx, id) pairs.
const KDF_CONTEXTS = [
  { name: 'memry-vault-key-v1', ctx: 'memryvlt', id: 1 },
  { name: 'memry-signing-key-v1', ctx: 'memrysgn', id: 2 },
  { name: 'memry-verify-key-v1', ctx: 'memryvrf', id: 3 },
  { name: 'memry-key-verifier-v1', ctx: 'memrykve', id: 4 },
  { name: 'memry-linking-enc-v1', ctx: 'memrylnk', id: 5 },
  { name: 'memry-linking-mac-v1', ctx: 'memrymac', id: 6 },
  { name: 'memry-linking-sas-v1', ctx: 'memrysas', id: 7 }
] as const

const hex = (bytes: Uint8Array): string => sodium.to_hex(bytes)
const fromHex = (value: string): Uint8Array => sodium.from_hex(value)
const utf8 = (value: string): Uint8Array => sodium.from_string(value)

// Fixed, arbitrary test material (never reuse in production).
// Public parity fixtures, not secrets — committed on purpose so both shells
// can byte-compare against them.
const PARITY_PASSPHRASE_PROD = 'correct horse battery staple — memry parity'
const PARITY_PASSPHRASE_SMOKE = 'memry-smoke'

const SEED_A = 'a0'.repeat(32)
const SEED_B = '5c'.repeat(32)
const KEY_32_A = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'
const KEY_32_B = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef'
const NONCE_24_A = '000102030405060708090a0b0c0d0e0f1011121314151617'
const NONCE_24_B = '17161514131211100f0e0d0c0b0a09080706050403020100'

const main = async (): Promise<void> => {
  await sodium.ready

  // --- Argon2id (production params + a fast smoke vector) ---
  const argonProd = {
    description: 'production params — the on-device gate vector (64 MiB / ops 3)',
    passwordUtf8: PARITY_PASSPHRASE_PROD,
    saltHex: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    opsLimit: ARGON2_PARAMS.OPS_LIMIT,
    memLimit: ARGON2_PARAMS.MEMORY_LIMIT,
    outLength: 32,
    algorithm: 'ARGON2ID13',
    derivedHex: ''
  }
  argonProd.derivedHex = hex(
    sodium.crypto_pwhash(
      argonProd.outLength,
      utf8(argonProd.passwordUtf8),
      fromHex(argonProd.saltHex),
      argonProd.opsLimit,
      argonProd.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
  )

  const argonSmoke = {
    description: 'minimum-params smoke vector (fast harness sanity check)',
    passwordUtf8: PARITY_PASSPHRASE_SMOKE,
    saltHex: '000102030405060708090a0b0c0d0e0f',
    opsLimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
    memLimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
    outLength: 32,
    algorithm: 'ARGON2ID13',
    derivedHex: ''
  }
  argonSmoke.derivedHex = hex(
    sodium.crypto_pwhash(
      argonSmoke.outLength,
      utf8(argonSmoke.passwordUtf8),
      fromHex(argonSmoke.saltHex),
      argonSmoke.opsLimit,
      argonSmoke.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
  )

  // --- XChaCha20-Poly1305 IETF AEAD ---
  const aeadCases = [
    {
      description: 'markdown body, no associated data',
      keyHex: KEY_32_A,
      nonceHex: NONCE_24_A,
      plaintextUtf8: '# Parity note\n\nSame bytes on every shell.\n',
      adHex: null as string | null,
      ciphertextHex: ''
    },
    {
      description: 'binary plaintext with associated data',
      keyHex: KEY_32_B,
      nonceHex: NONCE_24_B,
      plaintextHex: 'deadbeef00ff10203040506070809090',
      adHex: '6d656d72792d6164', // "memry-ad"
      ciphertextHex: ''
    }
  ]
  for (const c of aeadCases) {
    const plaintext =
      'plaintextUtf8' in c && c.plaintextUtf8
        ? utf8(c.plaintextUtf8)
        : fromHex((c as { plaintextHex: string }).plaintextHex)
    c.ciphertextHex = hex(
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        c.adHex ? fromHex(c.adHex) : null,
        null,
        fromHex(c.nonceHex),
        fromHex(c.keyHex)
      )
    )
  }

  // --- Ed25519: seed keypair + detached signature ---
  const edSeedPair = sodium.crypto_sign_seed_keypair(fromHex(SEED_A))
  const edMessage = 'memry device signature parity'
  const ed25519 = {
    seedHex: SEED_A,
    publicKeyHex: hex(edSeedPair.publicKey),
    secretKeyHex: hex(edSeedPair.privateKey),
    messageUtf8: edMessage,
    detachedSignatureHex: hex(sodium.crypto_sign_detached(utf8(edMessage), edSeedPair.privateKey)),
    // deviceId derivation as in desktop keys.ts: hex(generichash(16, publicKey))
    deviceIdHex: sodium.to_hex(sodium.crypto_generichash(16, edSeedPair.publicKey, null))
  }

  // --- crypto_kdf_derive_from_key: every production context ---
  const kdfMasterHex = KEY_32_A
  const kdf = KDF_CONTEXTS.map((c) => ({
    contextName: c.name,
    ctx: c.ctx,
    subkeyId: c.id,
    length: 32,
    masterKeyHex: kdfMasterHex,
    derivedHex: hex(sodium.crypto_kdf_derive_from_key(32, c.id, c.ctx, fromHex(kdfMasterHex)))
  }))

  // --- generichash: keyed + custom lengths ---
  const generichash = [
    {
      description: 'unkeyed, 16-byte output (deviceId shape)',
      messageHex: hex(edSeedPair.publicKey),
      keyHex: null as string | null,
      outLength: 16,
      hashHex: sodium.to_hex(sodium.crypto_generichash(16, edSeedPair.publicKey, null))
    },
    {
      description: 'keyed, 32-byte output',
      messageUtf8: 'memry generichash parity',
      keyHex: KEY_32_B,
      outLength: 32,
      hashHex: hex(
        sodium.crypto_generichash(32, utf8('memry generichash parity'), fromHex(KEY_32_B))
      )
    },
    {
      description: 'unkeyed, 4-byte output (SAS shape)',
      messageHex: KEY_32_A,
      keyHex: null,
      outLength: 4,
      hashHex: hex(sodium.crypto_generichash(4, fromHex(KEY_32_A), null))
    }
  ]

  // --- crypto_auth (HMAC-SHA512-256) ---
  const auth = [
    {
      messageUtf8: 'memry linking mac parity',
      keyHex: KEY_32_A,
      macHex: hex(sodium.crypto_auth(utf8('memry linking mac parity'), fromHex(KEY_32_A)))
    }
  ]

  // --- crypto_scalarmult (+ base) — the known react-native-libsodium gap ---
  const scalarA = fromHex(SEED_A)
  const scalarB = fromHex(SEED_B)
  const pubA = sodium.crypto_scalarmult_base(scalarA)
  const pubB = sodium.crypto_scalarmult_base(scalarB)
  const scalarmult = {
    base: [
      { scalarHex: SEED_A, publicKeyHex: hex(pubA) },
      { scalarHex: SEED_B, publicKeyHex: hex(pubB) }
    ],
    shared: [
      {
        description: 'ECDH both directions must agree',
        scalarHex: SEED_A,
        pointHex: hex(pubB),
        sharedSecretHex: hex(sodium.crypto_scalarmult(scalarA, pubB))
      },
      {
        scalarHex: SEED_B,
        pointHex: hex(pubA),
        sharedSecretHex: hex(sodium.crypto_scalarmult(scalarB, pubA))
      }
    ]
  }

  // --- box keypair: public key derivation from a fixed secret ---
  const boxKeypair = {
    description:
      'crypto_box keypair parity via public-key derivation from a fixed secret (crypto_box_keypair itself is random)',
    secretKeyHex: SEED_B,
    publicKeyHex: hex(sodium.crypto_scalarmult_base(fromHex(SEED_B)))
  }

  // --- Full vault-unlock flow (mirrors desktop keys.ts + encryption.ts) ---
  const password = 'memry mobile parity vault password'
  const kdfSalt = fromHex('0123456789abcdef0123456789abcdef')
  const masterKey = sodium.crypto_pwhash(
    32,
    utf8(password),
    kdfSalt,
    ARGON2_PARAMS.OPS_LIMIT,
    ARGON2_PARAMS.MEMORY_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  const verifierKey = sodium.crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey)
  const vaultKey = sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey)
  const fileKey = fromHex(KEY_32_B)
  const keyNonce = fromHex(NONCE_24_A)
  const dataNonce = fromHex(NONCE_24_B)
  const plaintextMarkdown =
    '---\ntitle: Parity\n---\n\n# Parity\n\nDecrypted on every shell, byte for byte.\n'
  const encryptedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    fileKey,
    null,
    null,
    keyNonce,
    vaultKey
  )
  const encryptedData = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8(plaintextMarkdown),
    null,
    null,
    dataNonce,
    fileKey
  )
  const vaultUnlockFlow = {
    description:
      'password → Argon2id(64 MiB/3) → masterKey; verifier = b64(kdf id4 memrykve); vaultKey = kdf id1 memryvlt; AEAD-unwrap fileKey; AEAD-open body; sha256(plaintext) must equal desktop',
    passwordUtf8: password,
    kdfSaltHex: hex(kdfSalt),
    argon2: { opsLimit: ARGON2_PARAMS.OPS_LIMIT, memLimit: ARGON2_PARAMS.MEMORY_LIMIT },
    masterKeyHex: hex(masterKey),
    keyVerifierBase64: sodium.to_base64(verifierKey, sodium.base64_variants.ORIGINAL),
    vaultKeyHex: hex(vaultKey),
    fileKeyHex: hex(fileKey),
    keyNonceHex: hex(keyNonce),
    encryptedKeyHex: hex(encryptedKey),
    dataNonceHex: hex(dataNonce),
    encryptedDataHex: hex(encryptedData),
    plaintextMarkdownUtf8: plaintextMarkdown,
    plaintextSha256Hex: createHash('sha256').update(plaintextMarkdown, 'utf8').digest('hex')
  }

  const vectors = {
    meta: {
      spec: '001-mobile-app T005 / R1 (G0-a)',
      sodiumVersion: sodium.SODIUM_VERSION_STRING,
      encoding: 'hex unless the field name says otherwise',
      constants: {
        argon2: ARGON2_PARAMS,
        xchacha20: XCHACHA20_PARAMS
      }
    },
    argon2id: [argonProd, argonSmoke],
    xchacha20poly1305Ietf: aeadCases,
    ed25519,
    kdfDeriveFromKey: kdf,
    generichash,
    auth,
    scalarmult,
    boxKeypair,
    vaultUnlockFlow
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '../test-vectors')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'crypto-vectors.json')
  writeFileSync(outPath, `${JSON.stringify(vectors, null, 2)}\n`)
  console.log(`wrote ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
