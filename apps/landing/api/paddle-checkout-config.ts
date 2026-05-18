export type PaddleCheckoutPlan = 'plus' | 'pro' | 'believer'
export type PaddleCheckoutCadence = 'monthly' | 'annual' | 'lifetime'

export type PaddleCheckoutIntent = {
  plan: PaddleCheckoutPlan
  cadence: PaddleCheckoutCadence
}

export type PaddleCheckoutConfig = {
  priceId: string
  customData: {
    app: 'memry'
    entitlement: 'sync'
    plan: PaddleCheckoutPlan
    cadence: PaddleCheckoutCadence
  }
}

type PaddleEnv = Record<string, string | undefined>

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

export function parsePaddleCheckoutIntent(input: unknown): PaddleCheckoutIntent | null {
  if (!input || typeof input !== 'object') return null

  const { plan, cadence } = input as { plan?: unknown; cadence?: unknown }
  if (!isPlan(plan) || !isCadence(cadence)) return null

  if (plan === 'believer') {
    return { plan, cadence: 'lifetime' }
  }

  if (cadence === 'lifetime') return null

  return { plan, cadence }
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
      cadence: intent.cadence
    }
  }
}
