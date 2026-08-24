import { shell } from 'electron'
import { getFromServer, postToServer } from '../sync/http-client'
import { getValidAccessToken } from '../sync/token-manager'
import { startSyncRuntime } from '../sync/runtime'
import { createLogger } from '../lib/logger'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import {
  getCachedEntitlement,
  isPaidBillingStatus,
  setCachedEntitlementFromStatus,
  type CachedEntitlement
} from './entitlement-cache'

const log = createLogger('Billing')
// The account-area plan picker; it accepts the desktop-minted checkout token
// in the hash so the user lands signed-in-like, with no separate web login.
const DEFAULT_CHECKOUT_PAGE_URL = 'https://memrynote.com/account/sync'

export type BillingPlanId = 'plus' | 'pro' | 'believer'
export type BillingCadence = 'monthly' | 'annual' | 'lifetime'
export type BillingStatusValue = 'inactive' | 'active' | 'past_due' | 'paused' | 'canceled'
export type BillingPlan = 'free' | BillingPlanId

export interface BillingStatus {
  plan: BillingPlan
  status: BillingStatusValue
  source: string
  email: string | null
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

export async function startBillingCheckout(): Promise<
  BillingActionResult & { checkoutUrl?: string }
> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to start checkout' }

  const response = await postToServer<{ checkoutToken: string }>('/auth/checkout-token', {}, token)
  const checkoutUrl = buildCheckoutPageUrl(response.checkoutToken)
  await shell.openExternal(checkoutUrl)

  return { success: true, checkoutUrl }
}

export async function getBillingStatus(): Promise<
  BillingStatus | (BillingActionResult & { status?: never })
> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to view billing' }
  const result = await getFromServer<BillingStatus>('/auth/billing', token)
  setCachedEntitlementFromStatus(result)
  return result
}

export async function refreshBillingStatus(input?: {
  transactionId?: string
}): Promise<BillingStatus | (BillingActionResult & { status?: never })> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to refresh billing' }
  const result = await postToServer<BillingStatus>(
    '/auth/billing/reconcile',
    input?.transactionId ? { transactionId: input.transactionId } : {},
    token
  )
  setCachedEntitlementFromStatus(result)
  return result
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
      if ('plan' in status && isPaidBillingStatus(status)) {
        // refreshBillingStatus already cached this status; start the runtime and
        // use the engine it returns rather than re-reading getSyncEngine() (which
        // can be null if a concurrent start is still in flight).
        const engine = await startSyncRuntime()
        await engine?.fullSync()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  } catch (error) {
    log.warn('Failed to reconcile billing from deep link', {
      error: error instanceof Error ? error.message : String(error)
    })
    // A user who just completed checkout can silently fail to activate.
    trackMainError('billing', 'deep_link_reconcile', error)
  }
}

export async function resolveEntitlementForSyncStart(): Promise<CachedEntitlement> {
  const cached = getCachedEntitlement()
  if (cached && !cached.isPaid) return cached // known-unpaid: no server call

  try {
    const result = await getBillingStatus()
    if ('plan' in result) {
      return {
        isPaid: isPaidBillingStatus(result),
        plan: result.plan,
        status: result.status
      }
    }
    log.warn('Billing status unavailable; treating as unpaid for this launch')
    // Envelope failure (e.g. signed out): no exception object, but a paying
    // user may be degraded to free-plan gating for the whole launch.
    trackMainLog('warn', { scope: 'Billing', action: 'entitlement_unavailable_treated_unpaid' })
  } catch (error) {
    log.warn('Billing status fetch failed; treating as unpaid for this launch', {
      error: error instanceof Error ? error.message : String(error)
    })
    trackMainError('billing', 'entitlement_resolve', error)
  }
  return cached ?? { isPaid: false, plan: 'free', status: 'inactive' }
}

function getCheckoutPageUrl(): string {
  return process.env.CHECKOUT_PAGE_URL?.trim() || DEFAULT_CHECKOUT_PAGE_URL
}

function buildCheckoutPageUrl(checkoutToken: string): string {
  const params = new URLSearchParams({ token: checkoutToken })
  return `${getCheckoutPageUrl()}#${params.toString()}`
}
