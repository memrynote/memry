import { AppError, ErrorCodes } from './errors'

export const safeBase64Decode = (input: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0))
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed base64 input', 400)
  }
}

const BASE64_CHUNK_SIZE = 8192

/** Chunked so a multi-MiB blob never spreads more arguments than `fromCharCode` takes. */
export const safeBase64Encode = (input: ArrayBuffer | ArrayLike<number>): string => {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : Uint8Array.from(input)
  let result = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    result += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE))
  }
  return btoa(result)
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
