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

export function parseCheckoutToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')?.trim()
  return token && token.length > 0 ? token : null
}
