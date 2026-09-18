interface CheckoutTokenPayload {
  userId: string
  exp: number
  /**
   * Billing snapshot at mint time. Optional so tokens minted by older builds stay valid, and so a
   * verifier that predates these fields keeps working. The landing checkout reads
   * `hasSubscription` to refuse selling a second, parallel subscription.
   */
  plan?: string
  cadence?: string
  hasSubscription?: boolean
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
