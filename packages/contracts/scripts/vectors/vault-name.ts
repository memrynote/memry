/**
 * Class: vault-name and vault-icon envelopes (`vault-name.json`), chapter 04
 * §4.15 and §4.16.
 *
 * Generated through Electron's `apps/desktop/src/main/sync/vault-name-crypto.ts`,
 * imported for real, with the `randombytes_buf` of its libsodium instance
 * swapped for a fixed nonce while each case seals. Every `open` case is decided
 * by Electron's `decryptVaultName` or `decryptVaultIcon`, so `plaintext: null`
 * is a refusal Electron makes.
 */
import { createRequire } from 'node:module'

import type sodium from 'libsodium-wrappers-sumo'

// A namespace import: desktop's sources are CommonJS to Node, and the ESM
// loader cannot see their named exports statically.
import * as electronModule from '../../../../apps/desktop/src/main/sync/vault-name-crypto.ts'
import { b64, fromB64, fromHex, hex } from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

// Loaded as CommonJS, the exports may sit under `default`.
type Electron = typeof electronModule
const electron: Electron =
  (electronModule as Electron & { default?: Electron }).default ?? electronModule

// The libsodium instance `encryption.ts` holds: its CommonJS `require`, not
// this script's ESM import, which Node loads as a second instance.
const electronSodium: typeof sodium = createRequire(
  new URL('../../../../apps/desktop/src/main/crypto/encryption.ts', import.meta.url)
)('libsodium-wrappers-sumo')

const VAULT_KEY = '3c8f0e2b7a9d14c65e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f'
const OTHER_KEY = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
const VAULT_UUID = '0f8e3a52-9c1d-4b7e-a2f0-5d6c7b8a9e01'
const OTHER_UUID = '7f1d2c3b-4a59-4687-9d0e-1f2a3b4c5d6e'

type Kind = 'name' | 'icon'

interface SealSpec {
  name: string
  kind: Kind
  vaultUuid: string
  plaintext: string
}

const SEALS: SealSpec[] = [
  { name: 'name, ascii', kind: 'name', vaultUuid: VAULT_UUID, plaintext: 'Personal' },
  { name: 'name, empty', kind: 'name', vaultUuid: VAULT_UUID, plaintext: '' },
  {
    name: 'name, Turkish and emoji',
    kind: 'name',
    vaultUuid: VAULT_UUID,
    plaintext: 'İş notları 🗂️ Ağustos'
  },
  { name: 'name, 200 characters', kind: 'name', vaultUuid: OTHER_UUID, plaintext: 'v'.repeat(200) },
  { name: 'name, short vault id', kind: 'name', vaultUuid: 'v1', plaintext: 'Work' },
  { name: 'icon, library icon', kind: 'icon', vaultUuid: VAULT_UUID, plaintext: 'icon:Book01Icon' },
  { name: 'icon, emoji', kind: 'icon', vaultUuid: VAULT_UUID, plaintext: '🌿' },
  {
    name: 'icon, ZWJ emoji sequence',
    kind: 'icon',
    vaultUuid: OTHER_UUID,
    plaintext: '👩‍👩‍👧‍👦'
  },
  {
    // `TextDecoder` drops one leading byte-order mark, so this opens without it.
    name: 'name, leading byte-order mark',
    kind: 'name',
    vaultUuid: VAULT_UUID,
    plaintext: '\uFEFF\uFEFFPlan'
  }
]

/** Nonce `i`: 24 bytes counting up from `i * 24 + 1`. */
const nonceFor = (index: number): Uint8Array =>
  Uint8Array.from({ length: 24 }, (_, at) => (index * 24 + at + 1) & 0xff)

interface Sealed {
  ciphertext: string
  nonce: string
}

function sealWithNonce(spec: SealSpec, key: Uint8Array, nonce: Uint8Array): Sealed {
  const random = electronSodium.randombytes_buf
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `encrypt` calls only the Uint8Array overload
  electronSodium.randombytes_buf = (() => nonce.slice()) as typeof sodium.randombytes_buf
  try {
    if (spec.kind === 'name') {
      const { encryptedName, nameNonce } = electron.encryptVaultName(
        spec.plaintext,
        key,
        spec.vaultUuid
      )
      return { ciphertext: encryptedName, nonce: nameNonce }
    }
    const { encryptedIcon, iconNonce } = electron.encryptVaultIcon(
      spec.plaintext,
      key,
      spec.vaultUuid
    )
    return { ciphertext: encryptedIcon, nonce: iconNonce }
  } finally {
    electronSodium.randombytes_buf = random
  }
}

/** What Electron reads back: the plaintext, or `null` when it refuses. */
function electronOpen(
  kind: Kind,
  sealed: Sealed,
  key: Uint8Array,
  vaultUuid: string
): string | null {
  return kind === 'name'
    ? electron.decryptVaultName(sealed.ciphertext, sealed.nonce, key, vaultUuid)
    : electron.decryptVaultIcon(sealed.ciphertext, sealed.nonce, key, vaultUuid)
}

function flipFirstByte(base64: string): string {
  const bytes = fromB64(base64)
  bytes[0] ^= 0x01
  return b64(bytes)
}

function unpadded(base64: string): string {
  const stripped = base64.replace(/=+$/, '')
  if (stripped === base64) throw new Error('vault-name: the unpadded case needs padding to strip')
  return stripped
}

/**
 * Bytes that are not UTF-8, sealed under the name AAD with the same primitive
 * Electron's `encrypt` calls. No Electron writer produces them (its input is a
 * string), so the case pins only what Electron's reader makes of them.
 */
function sealedBytes(bytes: Uint8Array, key: Uint8Array, nonce: Uint8Array): Sealed {
  const aad = new TextEncoder().encode(`vault-name-v1:${VAULT_UUID}`)
  const ciphertext = electronSodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    bytes,
    aad,
    null,
    nonce,
    key
  )
  return { ciphertext: b64(ciphertext), nonce: b64(nonce) }
}

export async function buildVaultName(): Promise<Record<string, unknown>> {
  // A second instance: the entry point's `await ready` does not initialise it.
  await electronSodium.ready
  const key = fromHex(VAULT_KEY)
  const seals = SEALS.map((spec, index) => {
    const nonce = nonceFor(index)
    const sealed = sealWithNonce(spec, key, nonce)
    if (sealed.nonce !== b64(nonce)) {
      throw new Error(`vault-name: ${spec.name} was not sealed under the fixed nonce`)
    }
    const opened = electronOpen(spec.kind, sealed, key, spec.vaultUuid)
    const expected = spec.plaintext.startsWith('\uFEFF') ? spec.plaintext.slice(1) : spec.plaintext
    if (opened !== expected) {
      throw new Error(`vault-name: ${spec.name} does not open under Electron`)
    }
    return {
      ...spec,
      nonceHex: hex(nonce),
      ciphertextBase64: sealed.ciphertext,
      nonceBase64: sealed.nonce,
      opened
    }
  })

  const name: Sealed = { ciphertext: seals[0].ciphertextBase64, nonce: seals[0].nonceBase64 }
  const icon: Sealed = { ciphertext: seals[5].ciphertextBase64, nonce: seals[5].nonceBase64 }
  const padded: Sealed = { ciphertext: seals[2].ciphertextBase64, nonce: seals[2].nonceBase64 }
  const opens = [
    { name: 'a name does not open as an icon', kind: 'icon', sealed: name },
    { name: 'an icon does not open as a name', kind: 'name', sealed: icon },
    { name: 'another vault id', kind: 'name', sealed: name, vaultUuid: OTHER_UUID },
    { name: 'another key', kind: 'name', sealed: name, keyHex: OTHER_KEY },
    {
      name: 'one ciphertext bit flipped',
      kind: 'name',
      sealed: { ...name, ciphertext: flipFirstByte(name.ciphertext) }
    },
    {
      name: 'one nonce bit flipped',
      kind: 'icon',
      sealed: { ...icon, nonce: flipFirstByte(icon.nonce) }
    },
    {
      name: 'ciphertext shorter than the tag',
      kind: 'name',
      sealed: { ...name, ciphertext: b64(new Uint8Array(15)) }
    },
    {
      name: 'a 23-byte nonce',
      kind: 'name',
      sealed: { ...name, nonce: b64(fromB64(name.nonce).slice(0, 23)) }
    },
    {
      name: 'ciphertext without base64 padding',
      kind: 'name',
      sealed: { ...padded, ciphertext: unpadded(padded.ciphertext) }
    },
    { name: 'ciphertext not base64', kind: 'name', sealed: { ...name, ciphertext: '!!!' } },
    {
      name: 'plaintext not UTF-8',
      kind: 'name',
      sealed: sealedBytes(Uint8Array.from([0x57, 0xff, 0x6b]), key, nonceFor(20))
    }
  ].map((spec) => {
    const keyHex = spec.keyHex ?? VAULT_KEY
    const vaultUuid = spec.vaultUuid ?? VAULT_UUID
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every kind above is a Kind
    const kind = spec.kind as Kind
    return {
      name: spec.name,
      kind,
      keyHex,
      vaultUuid,
      ciphertextBase64: spec.sealed.ciphertext,
      nonceBase64: spec.sealed.nonce,
      plaintext: electronOpen(kind, spec.sealed, fromHex(keyHex), vaultUuid)
    }
  })

  return {
    meta: meta({
      chapter: 'docs/protocol/04-record-envelope.md §4.15, §4.16',
      oracle:
        'apps/desktop/src/main/sync/vault-name-crypto.ts (encryptVaultName, decryptVaultName, encryptVaultIcon, decryptVaultIcon) with a fixed nonce',
      note: '`keyHex` is the vault key (chapter 01 §1.7), not the master key. `ciphertextBase64` and `nonceBase64` are the `encryptedName`/`nameNonce` or `encryptedIcon`/`iconNonce` pair Electron sends; `opened` is what Electron reads back. An open case with `plaintext: null` is one Electron refuses.'
    }),
    keyHex: VAULT_KEY,
    seals,
    opens
  }
}
