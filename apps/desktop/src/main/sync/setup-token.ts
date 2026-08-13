import sodium from 'libsodium-wrappers-sumo'

import { RenewSetupTokenResponseSchema } from '@memry/contracts/auth-api'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

import {
  getDevicePublicKey,
  getOrCreateSigningKeyPair,
  retrieveKey,
  secureCleanup,
  storeKey
} from '../crypto'
import { createLogger } from '../lib/logger'
import { postToServer } from './http-client'
import { extractJtiFromToken, isTokenExpired, retrieveToken, storeToken } from './token-manager'

const log = createLogger('Sync:SetupToken')

const toBase64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

/**
 * The signing key must be the SAME one at sign-in (when its public half is
 * committed into the setup token) and at renewal (when it signs the challenge).
 * `getOrCreateSigningKeyPair()` mints an ephemeral pair whenever the keychain
 * is empty — a fresh install, which is precisely the recovery case — and only
 * `persistKeysAndRegisterDevice` stores it, far too late to be the commitment.
 * So persist it here, at the moment we commit to it.
 */
const getStableSigningSecretKey = async (): Promise<Uint8Array> => {
  const existing = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
  if (existing) return existing

  const pair = await getOrCreateSigningKeyPair()
  await storeKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY, pair.secretKey)
  return pair.secretKey
}

/**
 * Public half of this device's signing key, sent at sign-in so the server can
 * bind setup-token renewal to this device and nobody else.
 *
 * Best-effort: if it cannot be produced the field is simply omitted and the
 * setup token behaves exactly as it did before #1202 — one 5-minute grant, not
 * renewable.
 */
export const getSetupDevicePublicKey = async (): Promise<string | undefined> => {
  let secretKey: Uint8Array | undefined
  try {
    await sodium.ready
    secretKey = await getStableSigningSecretKey()
    return toBase64(getDevicePublicKey(secretKey))
  } catch (err) {
    log.warn('Could not commit a device key at sign-in — setup token will not be renewable', err)
    return undefined
  } finally {
    if (secretKey) secureCleanup(secretKey)
  }
}

const renewSetupToken = async (expiredToken: string): Promise<string | null> => {
  let secretKey: Uint8Array | undefined
  try {
    await sodium.ready
    secretKey = (await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)) ?? undefined
    if (!secretKey) {
      log.warn('No committed device key on this install — setup token cannot be renewed')
      return null
    }

    const challengeNonce = crypto.randomUUID()
    const jti = extractJtiFromToken(expiredToken)
    const signature = sodium.crypto_sign_detached(
      new TextEncoder().encode(`${challengeNonce}:${jti}`),
      secretKey
    )

    const raw = await postToServer<unknown>('/auth/setup-token/renew', {
      setupToken: expiredToken,
      challengeNonce,
      challengeSignature: toBase64(signature)
    })
    const { setupToken } = RenewSetupTokenResponseSchema.parse(raw)

    await storeToken(KEYCHAIN_ENTRIES.SETUP_TOKEN, setupToken)
    log.info('Renewed the setup token for an in-progress device setup')
    return setupToken
  } catch (err) {
    log.warn('Setup token renewal failed', err)
    return null
  } finally {
    if (secretKey) secureCleanup(secretKey)
  }
}

/**
 * The setup token the current device setup should use.
 *
 * #1202: the token is minted at sign-in but first used minutes later, once the
 * user has come back with their 24-word recovery phrase. Rather than dead-end
 * on the five-minute clock, renew it in place. Returns null only when there is
 * nothing left to renew, which is where the existing "sign in again" path takes
 * over.
 */
export const ensureLiveSetupToken = async (): Promise<string | null> => {
  const stored = await retrieveToken(KEYCHAIN_ENTRIES.SETUP_TOKEN)
  if (!stored) return null
  if (!isTokenExpired(stored)) return stored
  return renewSetupToken(stored)
}
