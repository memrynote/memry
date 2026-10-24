import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import sodium from 'libsodium-wrappers-sumo'
import { generateDeviceKeypair, buildDeviceChallenge } from './device-identity.ts'

describe('device identity', () => {
  it('produces a challenge signature the server scheme would verify', async () => {
    // oxlint-disable-next-line import/no-named-as-default-member -- the runtime ESM build of libsodium-wrappers-sumo exports only the default; the named exports exist in its types alone
    const { ready } = sodium
    await ready
    // oxlint-disable-next-line import/no-named-as-default-member -- the runtime ESM build of libsodium-wrappers-sumo exports only the default; the named exports exist in its types alone
    const { base64_variants, crypto_sign_verify_detached, from_base64 } = sodium
    const kp = await generateDeviceKeypair()
    const jwt = `h.${Buffer.from(JSON.stringify({ jti: 'jti-1' })).toString('base64url')}.s`

    const challenge = await buildDeviceChallenge(jwt, kp.signingKeyBase64, 'nonce-1')

    // Re-derive what the server verifies: nonce:jti signed by the device key.
    const sig = from_base64(challenge.challengeSignature, base64_variants.ORIGINAL)
    const pub = from_base64(challenge.authPublicKey, base64_variants.ORIGINAL)
    const msg = new TextEncoder().encode('nonce-1:jti-1')
    assert.equal(crypto_sign_verify_detached(sig, msg, pub), true)
    assert.equal(challenge.challengeNonce, 'nonce-1')
  })
})
