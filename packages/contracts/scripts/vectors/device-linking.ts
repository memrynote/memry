/**
 * Class: device linking (`device-linking.json`), 8 cases.
 *
 * The class that makes Q03.1 to Q03.5 answerable with something other than
 * prose: each answer becomes a case.
 *
 * Determinism: D1 throughout. The linking secret, the ephemeral key pair and
 * every derived subkey come from fixed seeds, so nothing here is random.
 *
 * WHERE THE CODE COMES FROM. The confirm channel's four MACs and the SAS are
 * `apps/desktop/src/main/crypto/keys.ts:165-229`, which sits behind the same
 * Electron import chain as desktop's record writer (see the header of
 * `record-envelope.ts`), so the generator calls libsodium directly with the
 * SAME construction and the desktop parity test asserts desktop's own
 * functions against these bytes. The scan channel is WebCrypto HMAC-SHA-256 on
 * both sides, reproduced here through `node:crypto`.
 *
 * The CBOR that both channels MAC is produced by the production encoder, which
 * is the part a second implementation actually gets wrong.
 *
 * Chapter: docs/protocol/03-device-linking.md.
 */
import { createHmac } from 'node:crypto'

import sodium from 'libsodium-wrappers-sumo'

import { CBOR_FIELD_ORDER } from '../../src/cbor-ordering'
import { encodeCbor } from '../../../sync-client/src/pull/cbor.ts'
import { FIXED, b64, fromHex, hex } from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
/** 32 fixed bytes standing in for the server's CSPRNG output. */
const LINKING_SECRET_HEX = '11'.repeat(32)
/** Initiator and new-device X25519 secrets. */
const INITIATOR_SECRET_HEX = FIXED.SEED_B
const NEW_DEVICE_SECRET_HEX = '7a'.repeat(32)

const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha256', Buffer.from(key)).update(Buffer.from(message)).digest())

export function buildDeviceLinking(): Record<string, unknown> {
  const linkingSecretBytes = fromHex(LINKING_SECRET_HEX)
  const linkingSecretB64 = b64(linkingSecretBytes)

  const initiatorSecret = fromHex(INITIATOR_SECRET_HEX)
  const initiatorPublic = sodium.crypto_scalarmult_base(initiatorSecret)
  const newDeviceSecret = fromHex(NEW_DEVICE_SECRET_HEX)
  const newDevicePublic = sodium.crypto_scalarmult_base(newDeviceSecret)

  const sharedFromNewDevice = sodium.crypto_scalarmult(newDeviceSecret, initiatorPublic)
  const sharedFromInitiator = sodium.crypto_scalarmult(initiatorSecret, newDevicePublic)

  const encKey = sodium.crypto_kdf_derive_from_key(32, 5, 'memrylnk', sharedFromNewDevice)
  const macKey = sodium.crypto_kdf_derive_from_key(32, 6, 'memrymac', sharedFromNewDevice)
  const sasKey = sodium.crypto_kdf_derive_from_key(32, 7, 'memrysas', sharedFromNewDevice)
  const wrongMacKey = sodium.crypto_kdf_derive_from_key(32, 6, 'memrymac', fromHex(FIXED.SEED_C))

  const initiatorPublicB64 = b64(initiatorPublic)
  const newDevicePublicB64 = b64(newDevicePublic)

  const proofPayload = encodeCbor(
    { sessionId: SESSION_ID, devicePublicKey: newDevicePublicB64 },
    CBOR_FIELD_ORDER.LINKING_PROOF
  )
  const scanConfirmPayload = encodeCbor(
    {
      sessionId: SESSION_ID,
      initiatorPublicKey: initiatorPublicB64,
      devicePublicKey: newDevicePublicB64
    },
    CBOR_FIELD_ORDER.SCAN_CONFIRM
  )

  // The master key block: XChaCha20-Poly1305 under encKey with NO associated
  // data — the asymmetry chapter 03 §3.10 insists on.
  const masterKey = fromHex('2b'.repeat(32))
  const keyNonce = fromHex(FIXED.NONCE_24_A)
  const encryptedMasterKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    masterKey,
    null,
    null,
    keyNonce,
    encKey
  )
  const encryptedMasterKeyB64 = b64(encryptedMasterKey)
  const keyConfirmPayload = encodeCbor(
    { sessionId: SESSION_ID, encryptedMasterKey: encryptedMasterKeyB64 },
    CBOR_FIELD_ORDER.KEY_CONFIRM
  )

  const sasHash = sodium.crypto_generichash(4, sasKey, null)
  const sasU32 = ((sasHash[0] << 24) | (sasHash[1] << 16) | (sasHash[2] << 8) | sasHash[3]) >>> 0
  const sasCode = (sasU32 % 1000000).toString().padStart(6, '0')

  // A transcript with one byte changed must yield a different code.
  const alteredShared = new Uint8Array(sharedFromNewDevice)
  alteredShared[0] ^= 0x01
  const alteredSasKey = sodium.crypto_kdf_derive_from_key(32, 7, 'memrysas', alteredShared)
  const alteredHash = sodium.crypto_generichash(4, alteredSasKey, null)
  const alteredU32 =
    ((alteredHash[0] << 24) | (alteredHash[1] << 16) | (alteredHash[2] << 8) | alteredHash[3]) >>> 0

  const cases = [
    {
      name: 'scanProof — the scan channel MAC',
      channel: 'scan',
      algorithm: 'HMAC-SHA-256',
      keyHex: LINKING_SECRET_HEX,
      keySource: 'the DECODED 32 bytes of linkingSecret, not the base64 string',
      cborOrdering: 'LINKING_PROOF',
      messageHex: hex(proofPayload),
      expectedMacB64: b64(hmacSha256(linkingSecretBytes, proofPayload)),
      pins: 'WebCrypto HMAC-SHA-256 keyed by the linking secret, and the exact CBOR message'
    },
    {
      name: 'scanConfirm — the scan channel, three-field ordering',
      channel: 'scan',
      algorithm: 'HMAC-SHA-256',
      keyHex: LINKING_SECRET_HEX,
      cborOrdering: 'SCAN_CONFIRM',
      messageHex: hex(scanConfirmPayload),
      expectedMacB64: b64(hmacSha256(linkingSecretBytes, scanConfirmPayload)),
      pins: 'the only ordering carrying initiatorPublicKey'
    },
    {
      name: 'newDeviceConfirm — the SAME message on the confirm channel',
      channel: 'confirm',
      algorithm: 'crypto_auth (HMAC-SHA512-256)',
      keyHex: hex(macKey),
      cborOrdering: 'LINKING_PROOF',
      messageHex: hex(proofPayload),
      expectedMacB64: b64(sodium.crypto_auth(proofPayload, macKey)),
      pins: 'LINKING_PROOF is used by BOTH families over identical bytes with different keys and different primitives. Both tags ride in the same /scan body'
    },
    {
      name: 'keyConfirm — the confirm channel over the master key block',
      channel: 'confirm',
      algorithm: 'crypto_auth (HMAC-SHA512-256)',
      keyHex: hex(macKey),
      cborOrdering: 'KEY_CONFIRM',
      messageHex: hex(keyConfirmPayload),
      expectedMacB64: b64(sodium.crypto_auth(keyConfirmPayload, macKey)),
      pins: 'the value MACd is the base64 STRING of the ciphertext, not its raw bytes'
    },
    {
      name: 'the master key block',
      encKeyHex: hex(encKey),
      keyNonceHex: FIXED.NONCE_24_A,
      masterKeyHex: hex(masterKey),
      encryptedMasterKeyB64,
      associatedData: null,
      pins: 'NO associated data on this block, unlike the two optional blocks'
    },
    {
      name: 'the SAS derivation',
      sharedSecretHex: hex(sharedFromNewDevice),
      sasKeyHex: hex(sasKey),
      generichash4Hex: hex(sasHash),
      uint32BigEndian: sasU32,
      expectedCode: sasCode,
      pins: 'six decimal digits, big-endian uint32 % 10^6, zero padded. The 2^32 mod 10^6 bias MUST be reproduced, not corrected: rejection sampling produces a different code and breaks linking'
    }
  ]

  const failureCases = [
    {
      name: 'a confirm MAC verified with the wrong subkey',
      messageHex: hex(keyConfirmPayload),
      macB64: b64(sodium.crypto_auth(keyConfirmPayload, macKey)),
      verifyWithKeyHex: hex(wrongMacKey),
      expectValid: false,
      pins: 'a MAC from a different shared secret must not verify'
    },
    {
      name: 'a SAS from a transcript with one byte changed',
      alteredSharedSecretHex: hex(alteredShared),
      expectedCode: (alteredU32 % 1000000).toString().padStart(6, '0'),
      mustDifferFrom: sasCode,
      pins: 'the whole point of the SAS: a changed transcript shows a different code'
    }
  ]

  return {
    meta: meta({
      class: 'device-linking',
      chapter: 'docs/protocol/03-device-linking.md',
      sessionId: SESSION_ID,
      linkingSecretB64,
      linkingSecretBytes: linkingSecretBytes.length,
      ecdh: {
        initiatorPublicB64,
        newDevicePublicB64,
        sharedSecretsAgree: hex(sharedFromNewDevice) === hex(sharedFromInitiator)
      },
      subkeys: { encryption: 'memrylnk/5', mac: 'memrymac/6', sas: 'memrysas/7' },
      desktopParityAssertedIn: 'apps/desktop/src/main/sync/vector-parity.test.ts',
      sessionTtlSeconds: 300,
      caseCount: cases.length + failureCases.length
    }),
    cases,
    failureCases
  }
}
