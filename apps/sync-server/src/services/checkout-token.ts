import type { SyncPlan } from './entitlements'

export type CheckoutCadence = 'monthly' | 'annual' | 'lifetime'

interface CheckoutTokenPayload {
  userId: string
  plan: Exclude<SyncPlan, 'free'>
  cadence: CheckoutCadence
  exp: number
}

const encoder = new TextEncoder()

function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return new Uint8Array(signature)
}

export async function signCheckoutToken(
  secret: string,
  payload: CheckoutTokenPayload
): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = await hmacSha256(secret, encodedPayload)
  return `${encodedPayload}.${base64UrlEncode(signature)}`
}
