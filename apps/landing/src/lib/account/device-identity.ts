import { getSodium } from './sodium'
import { extractJti } from './extract-jti'

export interface DeviceKeypair {
  publicKeyBase64: string
  // Ed25519 signing key (seed || public), base64 ORIGINAL encoded
  signingKeyBase64: string
}

export async function generateDeviceKeypair(): Promise<DeviceKeypair> {
  const sodium = await getSodium()
  const kp = sodium.crypto_sign_keypair()
  return {
    publicKeyBase64: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    signingKeyBase64: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL)
  }
}

export interface DeviceChallenge {
  authPublicKey: string
  challengeSignature: string
  challengeNonce: string
}

export async function buildDeviceChallenge(
  setupToken: string,
  signingKeyBase64: string,
  nonce: string = crypto.randomUUID()
): Promise<DeviceChallenge> {
  const sodium = await getSodium()
  const signingKey = sodium.from_base64(signingKeyBase64, sodium.base64_variants.ORIGINAL)
  const publicKey = signingKey.slice(32) // Ed25519 key = seed(32) || public(32)
  const jti = extractJti(setupToken)
  const payload = new TextEncoder().encode(`${nonce}:${jti}`)
  const signature = sodium.crypto_sign_detached(payload, signingKey)
  return {
    authPublicKey: sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL),
    challengeSignature: sodium.to_base64(signature, sodium.base64_variants.ORIGINAL),
    challengeNonce: nonce
  }
}
