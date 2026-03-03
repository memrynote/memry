import { AppError, ErrorCodes } from './errors'

export const safeBase64Decode = (input: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0))
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed base64 input', 400)
  }
}

export const verifyEd25519 = async (
  publicKeyBase64: string,
  signatureBase64: string,
  payload: Uint8Array
): Promise<boolean> => {
  const keyBytes = safeBase64Decode(publicKeyBase64)
  const sigBytes = safeBase64Decode(signatureBase64)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'Ed25519', namedCurve: 'Ed25519' },
    false,
    ['verify']
  )

  return crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, payload)
}
