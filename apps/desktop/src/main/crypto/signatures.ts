import sodium from 'libsodium-wrappers-sumo'

import { encodeCbor } from './cbor'

export const signPayload = (
  payload: Record<string, unknown>,
  fieldOrder: readonly string[],
  secretKey: Uint8Array
): Uint8Array => {
  const message = encodeCbor(payload, fieldOrder)
  return sodium.crypto_sign_detached(message, secretKey)
}

export const verifySignature = (
  payload: Record<string, unknown>,
  fieldOrder: readonly string[],
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean => {
  const message = encodeCbor(payload, fieldOrder)
  return sodium.crypto_sign_verify_detached(signature, message, publicKey)
}
