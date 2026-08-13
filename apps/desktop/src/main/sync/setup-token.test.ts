import sodium from 'libsodium-wrappers-sumo'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

/**
 * The keychain and the network are stubbed; the signing is real. A renewal that
 * carried a bogus signature would be rejected by the server, so the test
 * verifies the challenge signature with libsodium exactly as the server does
 * rather than asserting "postToServer was called".
 */

type KeychainEntry = (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES]

const keychain = new Map<KeychainEntry, Uint8Array>()

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))

vi.mock('../crypto', async () => {
  const libsodium = (await import('libsodium-wrappers-sumo')).default
  await libsodium.ready
  return {
    // Copy in and out, like a real keychain — so secureCleanup zeroing the
    // caller's buffer cannot corrupt what was stored.
    storeKey: vi.fn(async (entry: KeychainEntry, bytes: Uint8Array) => {
      keychain.set(entry, new Uint8Array(bytes))
    }),
    retrieveKey: vi.fn(async (entry: KeychainEntry) => {
      const stored = keychain.get(entry)
      return stored ? new Uint8Array(stored) : null
    }),
    getOrCreateSigningKeyPair: vi.fn(async () => {
      const pair = libsodium.crypto_sign_keypair()
      return { deviceId: 'device-1', publicKey: pair.publicKey, secretKey: pair.privateKey }
    }),
    getDevicePublicKey: (secretKey: Uint8Array) =>
      libsodium.crypto_sign_ed25519_sk_to_pk(secretKey),
    secureCleanup: (...buffers: Uint8Array[]) => {
      for (const buffer of buffers) libsodium.memzero(buffer)
    }
  }
})

vi.mock('./http-client', () => ({
  postToServer: vi.fn(),
  SyncServerError: class extends Error {}
}))

import { postToServer } from './http-client'
import { ensureLiveSetupToken, getSetupDevicePublicKey } from './setup-token'

const base64Url = (value: string): string =>
  btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const mintToken = (jti: string, expiresInSeconds: number): string =>
  [
    base64Url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })),
    base64Url(
      JSON.stringify({
        sub: 'user-1',
        type: 'setup',
        jti,
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds
      })
    ),
    'signature'
  ].join('.')

const storeSetupToken = async (token: string): Promise<void> => {
  keychain.set(KEYCHAIN_ENTRIES.SETUP_TOKEN, new TextEncoder().encode(token))
}

const readSetupToken = (): string | null => {
  const stored = keychain.get(KEYCHAIN_ENTRIES.SETUP_TOKEN)
  return stored ? new TextDecoder().decode(stored) : null
}

describe('setup token renewal', () => {
  beforeEach(async () => {
    await sodium.ready
    keychain.clear()
    vi.mocked(postToServer).mockReset()
  })

  it('hands back the stored token while it is still live', async () => {
    // #given
    const live = mintToken('jti-live', 600)
    await storeSetupToken(live)

    // #when
    const token = await ensureLiveSetupToken()

    // #then no round trip is spent on a perfectly good token.
    expect(token).toBe(live)
    expect(postToServer).not.toHaveBeenCalled()
  })

  it('renews in place when the sign-in that minted the token has run out', async () => {
    // #given the #1202 shape: the user signed in, went to find their 24-word
    // recovery phrase, and came back to a dead token.
    const committedPublicKey = await getSetupDevicePublicKey()
    expect(committedPublicKey).toBeDefined()

    const expired = mintToken('jti-expired', -120)
    await storeSetupToken(expired)

    const renewed = mintToken('jti-renewed', 300)
    vi.mocked(postToServer).mockResolvedValue({ success: true, setupToken: renewed })

    // #when
    const token = await ensureLiveSetupToken()

    // #then the caller continues with a live token, and it is persisted so the
    // rest of the registration burst uses the same one.
    expect(token).toBe(renewed)
    expect(readSetupToken()).toBe(renewed)

    // #and the challenge really is signed by the key committed at sign-in.
    const [path, body] = vi.mocked(postToServer).mock.calls[0]!
    expect(path).toBe('/auth/setup-token/renew')
    const { challengeNonce, challengeSignature, setupToken } = body as {
      challengeNonce: string
      challengeSignature: string
      setupToken: string
    }
    expect(setupToken).toBe(expired)
    expect(
      sodium.crypto_sign_verify_detached(
        sodium.from_base64(challengeSignature, sodium.base64_variants.ORIGINAL),
        new TextEncoder().encode(`${challengeNonce}:jti-expired`),
        sodium.from_base64(committedPublicKey!, sodium.base64_variants.ORIGINAL)
      )
    ).toBe(true)
  })

  it('gives up rather than guessing when no device key was ever committed', async () => {
    // #given an install that signed in before the commitment existed.
    await storeSetupToken(mintToken('jti-expired', -120))

    // #when
    const token = await ensureLiveSetupToken()

    // #then it falls back to the existing "sign in again" path instead of
    // sending an unsignable renewal.
    expect(token).toBeNull()
    expect(postToServer).not.toHaveBeenCalled()
  })

  it('keeps the committed device key stable across calls', async () => {
    // #given the key committed at sign-in must be the same one that signs the
    // renewal minutes later — getOrCreateSigningKeyPair alone mints a fresh
    // ephemeral pair on a clean install.
    const first = await getSetupDevicePublicKey()

    // #when
    const second = await getSetupDevicePublicKey()

    // #then
    expect(second).toBe(first)
  })
})
