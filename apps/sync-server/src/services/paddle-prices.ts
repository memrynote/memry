import { AppError, ErrorCodes } from '../lib/errors'
import type { Bindings } from '../types'

/** Plans that are backed by a recurring Paddle subscription. `believer` is a one-time purchase. */
export type SubscriptionPlan = 'plus' | 'pro'
export type SubscriptionCadence = 'monthly' | 'annual'

// ponytail: same env var names as apps/landing/api/paddle-checkout-config.ts, which owns the
// first-purchase checkout. Two readers of one set of secrets; move to a shared package only if a
// third one shows up.
const PRICE_ENV_KEYS = {
  plus: {
    monthly: 'PADDLE_PRICE_PLUS_MONTHLY',
    annual: 'PADDLE_PRICE_PLUS_ANNUAL'
  },
  pro: {
    monthly: 'PADDLE_PRICE_PRO_MONTHLY',
    annual: 'PADDLE_PRICE_PRO_ANNUAL'
  }
} satisfies Record<SubscriptionPlan, Record<SubscriptionCadence, keyof Bindings>>

const PLAN_RANK: Record<SubscriptionPlan, number> = { plus: 1, pro: 2 }
const CADENCE_RANK: Record<SubscriptionCadence, number> = { monthly: 1, annual: 2 }

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return value === 'plus' || value === 'pro'
}

export function isSubscriptionCadence(value: unknown): value is SubscriptionCadence {
  return value === 'monthly' || value === 'annual'
}

export function resolveSubscriptionPriceId(
  env: Bindings,
  plan: SubscriptionPlan,
  cadence: SubscriptionCadence
): string {
  const priceId = env[PRICE_ENV_KEYS[plan][cadence]]
  if (typeof priceId !== 'string' || priceId.trim().length === 0) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      `Paddle price is not configured for ${plan} ${cadence}`,
      503
    )
  }
  return priceId.trim()
}

/**
 * Upgrade = nothing about the subscription gets smaller. A bigger plan is an upgrade at any
 * cadence; the same plan on a longer cadence is an upgrade. Everything else (smaller plan, or
 * annual→monthly) is a downgrade and must not charge the card today.
 */
export function isPlanUpgrade(
  from: { plan: SubscriptionPlan; cadence: SubscriptionCadence },
  to: { plan: SubscriptionPlan; cadence: SubscriptionCadence }
): boolean {
  if (PLAN_RANK[to.plan] !== PLAN_RANK[from.plan]) {
    return PLAN_RANK[to.plan] > PLAN_RANK[from.plan]
  }
  return CADENCE_RANK[to.cadence] > CADENCE_RANK[from.cadence]
}
