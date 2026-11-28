// Billing and the sync entitlement (Step 20, #3537). Electron has no billing e2e; these cases
// port the `paddle-billing.*.test.ts` flows through the local test server. The account's plan is
// the server's `sync_entitlements` row, written here the way a Paddle webhook writes it. The
// billing routes that call Paddle (reconcile, portal session, plan change) cannot run in the
// local Worker, so the sync proxy answers them with the body the Worker would send.
import { bootstrapSyncDevice, expect, test } from '../../fixtures/sync-proxy-fixtures'
import { openSettingsView } from '../../harness/app-helpers'
import type { Page } from '../../harness/pw-compat/page'
import type { SharedSyncBootstrap } from '../../harness/sync-backend'
import type { SyncProxy } from '../../harness/sync-proxy'
import type { TauriApp } from '../../harness/tauri-lifecycle'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

interface Grant {
  plan: 'free' | 'pro'
  cadence: 'monthly' | 'annual' | null
  status: 'active' | 'inactive'
  paddleCustomerId: string | null
}

const FREE: Grant = { plan: 'free', cadence: null, status: 'inactive', paddleCustomerId: null }
const PRO_MONTHLY: Grant = {
  plan: 'pro',
  cadence: 'monthly',
  status: 'active',
  paddleCustomerId: 'ctm_e2e'
}
const PRO_ANNUAL: Grant = { ...PRO_MONTHLY, cadence: 'annual' }

const LIMITS = {
  free: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
  pro: { storageLimit: 10 * GIB, maxFileSize: 200 * MIB, maxVaults: 10, versionHistoryDays: 365 }
}

/** Writes the account's entitlement row, as the Paddle webhook does. */
async function grant(bootstrap: SharedSyncBootstrap, next: Grant): Promise<void> {
  const limits = LIMITS[next.plan]
  const db = await bootstrap.server.getD1()
  await db
    .prepare(
      `UPDATE sync_entitlements
         SET plan = ?, cadence = ?, status = ?, source = 'paddle', paddle_customer_id = ?,
             storage_limit = ?, max_file_size = ?, max_vaults = ?, version_history_days = ?,
             updated_at = ?
       WHERE user_id = (SELECT id FROM users WHERE email = ?)`
    )
    .bind(
      next.plan,
      next.cadence,
      next.status,
      next.paddleCustomerId,
      limits.storageLimit,
      limits.maxFileSize,
      limits.maxVaults,
      limits.versionHistoryDays,
      Math.floor(Date.now() / 1000),
      bootstrap.email
    )
    .run()
}

/** The `GET /auth/billing` body the Worker sends for `next` (`formatBillingStatus`). */
function billingBody(bootstrap: SharedSyncBootstrap, next: Grant): Record<string, unknown> {
  return {
    plan: next.plan,
    cadence: next.cadence,
    status: next.status,
    source: 'paddle',
    email: bootstrap.email,
    limits: LIMITS[next.plan],
    usage: { storageUsed: 0 },
    expiresAt: null,
    canManageBilling: next.paddleCustomerId !== null,
    store: 'paddle',
    manageUrl: null,
    willRenew: true,
    appAccountToken: crypto.randomUUID()
  }
}

interface SyncState {
  status: string
  error: string | null
  lastSyncAt: number | null
}

function syncState(page: Page): Promise<SyncState> {
  return page.evaluate(async () => {
    const status = (await window.__TAURI__.core.invoke('sync_get_status')) as {
      status: string
      lastSyncAt?: number | null
      error?: string | null
    }
    return {
      status: status.status,
      error: status.error ?? null,
      lastSyncAt: status.lastSyncAt ?? null
    }
  })
}

/** Signs the device in and waits for its first finished sync pass; answers that pass's time. */
async function signIn(app: TauriApp, page: Page, bootstrap: SharedSyncBootstrap): Promise<number> {
  await bootstrapSyncDevice(app, bootstrap.deviceA)
  let lastSyncAt = 0
  await expect
    .poll(
      async () => {
        const state = await syncState(page)
        lastSyncAt = state.lastSyncAt ?? 0
        return { status: state.status, error: state.error, synced: state.lastSyncAt !== null }
      },
      { timeout: 30_000 }
    )
    .toEqual({ status: 'idle', error: null, synced: true })
  return lastSyncAt
}

function toast(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

function overridden(proxy: SyncProxy, method: string, path: string) {
  return proxy.requests({ method }).filter((entry) => entry.path === path && entry.overridden)
}

test.describe('Billing entitlement', () => {
  test('a free account shows the upgrade card, and a reconcile answering paid starts sync and removes it', async ({
    app,
    page,
    syncBootstrap,
    syncProxy
  }) => {
    const firstPassAt = await signIn(app, page, syncBootstrap)

    await grant(syncBootstrap, FREE)
    await openSettingsView(page, 'account')
    const upsell = page.getByText('Your notes live only on this device')
    await expect(upsell).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Unlock Sync' }).first()).toBeVisible()
    await expect.poll(async () => (await syncState(page)).status).toBe('local_only')

    // Checkout finished: the webhook wrote the paid row, and the reconcile reads the transaction.
    await grant(syncBootstrap, PRO_MONTHLY)
    syncProxy.injectFault({
      match: (method, path) => method === 'POST' && path === '/auth/billing/reconcile',
      status: 200,
      body: billingBody(syncBootstrap, PRO_MONTHLY),
      maxHits: 1
    })
    await page.getByRole('button', { name: 'Refresh status' }).click()

    await expect(toast(page, 'Billing is active')).toBeVisible({ timeout: 15_000 })
    await expect(upsell).toBeHidden()
    expect(overridden(syncProxy, 'POST', '/auth/billing/reconcile')).toHaveLength(1)
    await expect
      .poll(
        async () => {
          const state = await syncState(page)
          return {
            status: state.status,
            error: state.error,
            passedAgain: (state.lastSyncAt ?? 0) > firstPassAt
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({ status: 'idle', error: null, passedAgain: true })
    const [reconciled] = overridden(syncProxy, 'POST', '/auth/billing/reconcile')
    const syncedAfter = syncProxy
      .requests({ pathPrefix: '/sync/' })
      .filter((entry) => entry.at > reconciled.at && entry.status === 200)
    expect(syncedAfter.length).toBeGreaterThan(0)
  })

  test('a portal 409 shows the no-customer toast', async ({
    app,
    page,
    syncBootstrap,
    syncProxy
  }) => {
    await signIn(app, page, syncBootstrap)
    await grant(syncBootstrap, PRO_ANNUAL)
    await openSettingsView(page, 'account')

    const manage = page.getByRole('button', { name: 'Manage billing' })
    await expect(manage).toBeEnabled({ timeout: 15_000 })
    // The Worker's answer when Paddle has no customer for the account.
    syncProxy.injectFault({
      match: (method, path) => method === 'POST' && path === '/auth/billing/portal-session',
      status: 409,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Billing portal is not available until Paddle creates a customer'
        }
      },
      maxHits: 1
    })
    await manage.click()

    await expect(
      toast(page, 'No billing account found yet. If you just paid, choose Refresh status')
    ).toBeVisible({ timeout: 15_000 })
    expect(overridden(syncProxy, 'POST', '/auth/billing/portal-session')).toHaveLength(1)
  })

  test('the annual switch shows the preview and applies', async ({
    app,
    page,
    syncBootstrap,
    syncProxy
  }) => {
    await signIn(app, page, syncBootstrap)
    await grant(syncBootstrap, PRO_MONTHLY)
    await openSettingsView(page, 'account')

    const switchRow = page.getByText('Switch to yearly billing')
    await expect(switchRow).toBeVisible({ timeout: 15_000 })

    syncProxy.injectFault({
      match: (method, path) => method === 'POST' && path === '/auth/billing/change-plan/preview',
      status: 200,
      body: {
        plan: 'pro',
        cadence: 'annual',
        isUpgrade: true,
        effective: 'immediate',
        immediateChargeAmount: '4250',
        recurringAmount: '9600',
        currencyCode: 'USD',
        nextBilledAt: null
      },
      maxHits: 1
    })
    await page.getByRole('button', { name: 'Switch to yearly', exact: true }).click()
    await expect(page.getByText('$42.50 due today, then $96.00 per year')).toBeVisible({
      timeout: 15_000
    })
    expect(overridden(syncProxy, 'POST', '/auth/billing/change-plan/preview')).toHaveLength(1)

    await grant(syncBootstrap, PRO_ANNUAL)
    syncProxy.injectFault({
      match: (method, path) => method === 'POST' && path === '/auth/billing/change-plan',
      status: 200,
      body: billingBody(syncBootstrap, PRO_ANNUAL),
      maxHits: 1
    })
    await page.getByRole('button', { name: 'Confirm switch' }).click()

    await expect(toast(page, "You're on yearly billing now.")).toBeVisible({ timeout: 15_000 })
    await expect(switchRow).toBeHidden()
    expect(overridden(syncProxy, 'POST', '/auth/billing/change-plan')).toHaveLength(1)
  })
})
