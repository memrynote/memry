import { SYNC_PLAN_TIERS, type CheckoutPlanId } from './constants'
import type { PaddleCheckoutCadence } from './paddle-checkout'

export function getSelectableCadences(plan: CheckoutPlanId): PaddleCheckoutCadence[] {
  return plan === 'believer' ? ['lifetime'] : ['monthly', 'annual']
}

export function normalizeCadenceForPlan(
  plan: CheckoutPlanId,
  cadence: PaddleCheckoutCadence
): PaddleCheckoutCadence {
  if (plan === 'believer') return 'lifetime'
  return cadence === 'lifetime' ? 'annual' : cadence
}

export interface CheckoutSummary {
  planName: string
  amount: number
  currency: 'USD'
  billingFrequencyLabel: 'Monthly' | 'Yearly' | 'One-time'
  lineItemLabel: string
}

export function getCheckoutSummary(
  plan: CheckoutPlanId,
  cadence: PaddleCheckoutCadence
): CheckoutSummary | null {
  const tier = SYNC_PLAN_TIERS.find((t) => t.checkoutPlanId === plan)
  if (!tier) return null

  const normalized = normalizeCadenceForPlan(plan, cadence)
  const amount =
    normalized === 'monthly'
      ? tier.monthlyPrice
      : normalized === 'annual'
        ? tier.annualPrice
        : tier.lifetimePrice
  if (amount == null) return null

  const billingFrequencyLabel =
    normalized === 'monthly' ? 'Monthly' : normalized === 'annual' ? 'Yearly' : 'One-time'
  const lineItemLabel =
    normalized === 'lifetime'
      ? `${tier.name} lifetime`
      : `${tier.name} ${billingFrequencyLabel.toLowerCase()} subscription`

  return { planName: tier.name, amount, currency: 'USD', billingFrequencyLabel, lineItemLabel }
}

export interface CheckoutTokenClaims {
  userId: string | null
  plan: string | null
  cadence: string | null
  hasSubscription: boolean
}

/**
 * Reads the (signed) claims out of a checkout token for display only — the signature is verified
 * server-side on every call that matters. This exists so the desktop deep link, which carries a
 * token but no web session, can still tell a subscriber from a first-time buyer.
 */
export function readCheckoutTokenClaims(token: string | null): CheckoutTokenClaims | null {
  const encodedPayload = token?.split('.')[0]
  if (!encodedPayload) return null

  try {
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const payload: unknown = JSON.parse(json)
    if (!payload || typeof payload !== 'object') return null

    const claims = payload as Record<string, unknown>
    return {
      userId: typeof claims.userId === 'string' ? claims.userId : null,
      plan: typeof claims.plan === 'string' ? claims.plan : null,
      cadence: typeof claims.cadence === 'string' ? claims.cadence : null,
      hasSubscription: claims.hasSubscription === true
    }
  } catch {
    return null
  }
}

export function parseCheckoutToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')?.trim()
  return token && token.length > 0 ? token : null
}
