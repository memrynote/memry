// Signs one device into a fresh account on the local test server (Miniflare) through
// `e2e_bootstrap_sync_device` and waits for its first finished sync pass. The billing spec (Step 20)
// and the account and two-device ports (Step 19) start from this hook.
import { bootstrapSyncDevice, expect, test } from '../../fixtures/sync-auth-fixtures'

test.describe('Sync bootstrap', () => {
  test('signs the device in and finishes a sync pass', async ({ app, page, syncBootstrap }) => {
    await bootstrapSyncDevice(app, syncBootstrap.deviceA)

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const info = (await window.__TAURI__.core.invoke('account_get_info')) as {
            signedIn: boolean
            email: string | null
            deviceId: string | null
            needsRecoveryConfirmation: boolean
          }
          return { ...info, hasDevice: typeof info.deviceId === 'string' }
        })
      )
      .toMatchObject({
        signedIn: true,
        email: syncBootstrap.email,
        hasDevice: true,
        needsRecoveryConfirmation: false
      })

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const status = (await window.__TAURI__.core.invoke('sync_get_status')) as {
              status: string
              lastSyncAt?: number | null
              error?: string | null
            }
            return {
              status: status.status,
              error: status.error ?? null,
              synced: typeof status.lastSyncAt === 'number'
            }
          }),
        { timeout: 30_000 }
      )
      .toEqual({ status: 'idle', error: null, synced: true })
  })
})
