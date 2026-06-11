export type PaddleCheckoutPlan = 'plus' | 'pro' | 'believer'
export type PaddleCheckoutCadence = 'monthly' | 'annual' | 'lifetime'

export type PaddleCheckoutIntent = {
  plan: PaddleCheckoutPlan
  cadence: PaddleCheckoutCadence
  userId: string
}

type CheckoutTokenPayload = {
  plan?: unknown
  cadence?: unknown
  userId?: unknown
  exp?: unknown
}

export type PaddleCheckoutConfig = {
  priceId: string
  customData: {
    app: 'memry'
    entitlement: 'sync'
    plan: PaddleCheckoutPlan
    cadence: PaddleCheckoutCadence
    userId: string
  }
}

type PaddleEnv = Record<string, string | undefined>
const encoder = new TextEncoder()

export function normalizePaddleApiKey(apiKey: string | undefined) {
  const value = apiKey?.trim()
  if (!value) return undefined

  const unquoted = value.replace(/^(['"])(.*)\1$/, '$2').trim()
  const authorizationValue = unquoted.match(/^authorization:\s*bearer\s+(.+)$/i)?.[1]
  const bearerValue = unquoted.match(/^bearer\s+(.+)$/i)?.[1]

  return (authorizationValue ?? bearerValue ?? unquoted).trim() || undefined
}

const PRICE_ENV_KEYS: Record<PaddleCheckoutPlan, Record<PaddleCheckoutCadence, string | null>> = {
  plus: {
    monthly: 'PADDLE_PRICE_PLUS_MONTHLY',
    annual: 'PADDLE_PRICE_PLUS_ANNUAL',
    lifetime: null
  },
  pro: {
    monthly: 'PADDLE_PRICE_PRO_MONTHLY',
    annual: 'PADDLE_PRICE_PRO_ANNUAL',
    lifetime: null
  },
  believer: {
    monthly: 'PADDLE_PRICE_BELIEVER_LIFETIME',
    annual: 'PADDLE_PRICE_BELIEVER_LIFETIME',
    lifetime: 'PADDLE_PRICE_BELIEVER_LIFETIME'
  }
}

function isPlan(value: unknown): value is PaddleCheckoutPlan {
  return value === 'plus' || value === 'pro' || value === 'believer'
}

function isCadence(value: unknown): value is PaddleCheckoutCadence {
  return value === 'monthly' || value === 'annual' || value === 'lifetime'
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

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

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false

  let diff = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= left[index] ^ right[index]
  }
  return diff === 0
}

async function verifyCheckoutToken(
  token: string,
  secret: string | undefined
): Promise<CheckoutTokenPayload | null> {
  if (!secret) return null

  const [encodedPayload, encodedSignature, extra] = token.split('.')
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null

  const signature = base64UrlDecode(encodedSignature)
  if (!signature) return null

  const expected = await hmacSha256(secret, encodedPayload)
  if (!timingSafeEqual(signature, expected)) return null

  const payloadBytes = base64UrlDecode(encodedPayload)
  if (!payloadBytes) return null

  try {
    return JSON.parse(new TextDecoder().decode(payloadBytes)) as CheckoutTokenPayload
  } catch {
    return null
  }
}

export async function parsePaddleCheckoutIntent(
  input: unknown,
  env: PaddleEnv,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<PaddleCheckoutIntent | null> {
  if (!input || typeof input !== 'object') return null

  const { checkoutToken, plan, cadence } = input as {
    checkoutToken?: unknown
    plan?: unknown
    cadence?: unknown
  }
  if (typeof checkoutToken !== 'string' || checkoutToken.trim().length === 0) return null

  const tokenPayload = await verifyCheckoutToken(
    checkoutToken.trim(),
    env.PADDLE_CHECKOUT_TOKEN_SECRET
  )
  if (!tokenPayload) return null

  const { userId, exp } = tokenPayload
  if (typeof userId !== 'string' || userId.trim().length === 0) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) return null

  if (!isPlan(plan) || !isCadence(cadence)) return null

  if (plan === 'believer') {
    return { plan, cadence: 'lifetime', userId: userId.trim() }
  }

  if (cadence === 'lifetime') return null

  return { plan, cadence, userId: userId.trim() }
}

export async function signPaddleCheckoutToken(
  payload: { userId: string; exp: number },
  secret: string
): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = await hmacSha256(secret, encodedPayload)
  return `${encodedPayload}.${base64UrlEncode(signature)}`
}

export function getPaddleCheckoutConfig(
  intent: PaddleCheckoutIntent | null,
  env: PaddleEnv
): PaddleCheckoutConfig {
  if (!intent) {
    throw new Error('Invalid Paddle checkout intent')
  }

  const envKey = PRICE_ENV_KEYS[intent.plan][intent.cadence]
  if (!envKey) {
    throw new Error(`Paddle price is not configured for ${intent.plan}/${intent.cadence}`)
  }

  const priceId = env[envKey]
  if (!priceId) {
    throw new Error(`Missing Paddle price env var: ${envKey}`)
  }

  return {
    priceId,
    customData: {
      app: 'memry',
      entitlement: 'sync',
      plan: intent.plan,
      cadence: intent.cadence,
      userId: intent.userId
    }
  }
}
