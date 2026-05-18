import { shell } from 'electron'
import { getFromServer, postToServer } from '../sync/http-client'
import { getValidAccessToken } from '../sync/token-manager'
import { getSyncEngine } from '../sync/runtime'
import { createLogger } from '../lib/logger'

const log = createLogger('Billing')
const LANDING_CHECKOUT_URL = 'https://memrynote.com/pricing'

export type BillingPlanId = 'plus' | 'pro' | 'believer'
export type BillingCadence = 'monthly' | 'annual' | 'lifetime'
export type BillingStatusValue = 'inactive' | 'active' | 'past_due' | 'paused' | 'canceled'
export type BillingPlan = 'free' | BillingPlanId

export interface BillingStatus {
  plan: BillingPlan
  status: BillingStatusValue
  source: string
  limits: {
    storageLimit: number
    maxFileSize: number
    maxVaults: number | null
    versionHistoryDays: number
  }
  usage: {
    storageUsed: number
  }
  expiresAt: number | null
  canManageBilling: boolean
}

export interface BillingActionResult {
  success: boolean
  error?: string
}

export async function startBillingCheckout(input: {
  plan: BillingPlanId
  cadence: BillingCadence
}): Promise<BillingActionResult & { checkoutUrl?: string }> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to start checkout' }

  const cadence = input.plan === 'believer' ? 'lifetime' : input.cadence
  const response = await postToServer<{ checkoutToken: string }>(
    '/auth/checkout-token',
    { plan: input.plan, cadence },
    token
  )
  const checkoutUrl = buildLandingCheckoutUrl(input.plan, cadence, response.checkoutToken)
  await shell.openExternal(checkoutUrl)

  return { success: true, checkoutUrl }
}

export async function getBillingStatus(): Promise<
  BillingStatus | (BillingActionResult & { status?: never })
> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to view billing' }
  return getFromServer<BillingStatus>('/auth/billing', token)
}

export async function refreshBillingStatus(input?: {
  transactionId?: string
}): Promise<BillingStatus | (BillingActionResult & { status?: never })> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to refresh billing' }
  return postToServer<BillingStatus>(
    '/auth/billing/reconcile',
    input?.transactionId ? { transactionId: input.transactionId } : {},
    token
  )
}

export async function openBillingPortal(): Promise<BillingActionResult & { portalUrl?: string }> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to manage billing' }

  const response = await postToServer<{ portalUrl: string }>(
    '/auth/billing/portal-session',
    {},
    token
  )
  await shell.openExternal(response.portalUrl)
  return { success: true, portalUrl: response.portalUrl }
}

export async function reconcileBillingAndSync(input?: { transactionId?: string }): Promise<void> {
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = await refreshBillingStatus(input)
      if ('status' in status && status.status === 'active') {
        await getSyncEngine()?.fullSync()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  } catch (error) {
    log.warn('Failed to reconcile billing from deep link', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function buildLandingCheckoutUrl(
  plan: BillingPlanId,
  cadence: BillingCadence,
  checkoutToken: string
): string {
  const params = new URLSearchParams({
    checkout_plan: plan,
    checkout_cadence: cadence,
    checkout_token: checkoutToken
  })
  return `${LANDING_CHECKOUT_URL}#${params.toString()}`
}
