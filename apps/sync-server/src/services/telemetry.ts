import { AppError, ErrorCodes } from '../lib/errors'

const requireHmacKey = (key: string): string => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Telemetry HMAC key is not configured', 500)
  }
  return key
}

export const hashTelemetryId = async (secret: string, id: string): Promise<string> => {
  const keyMaterial = requireHmacKey(secret)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(id))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
