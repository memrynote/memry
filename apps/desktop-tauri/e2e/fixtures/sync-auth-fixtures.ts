// Binds both instances to one shared sync account: the port of
// tests/e2e/fixtures/sync-auth-fixtures.ts. `e2e_bootstrap_sync_device` is added by Step 17
// (#3534); no spec imports this file before that step merges.
import { waitForAppReady } from '../harness/app-helpers'
import { invokeTest } from '../harness/invoke-test'
import { expect } from '../harness/pw-compat/expect'
import type { Page } from '../harness/pw-compat/page'
import { startSharedSyncBootstrap, type SharedSyncBootstrap } from '../harness/sync-backend'
import type { TauriApp } from '../harness/tauri-lifecycle'
import { test as base } from './sync-fixtures'

/**
 * Bind one app profile to the shared sync account.
 *
 * Exported so a spec can stage devices one at a time: a fresh-device test needs A seeded and
 * pushed before B ever authenticates, which the `bootstrappedSyncPair` fixture cannot express.
 */
export async function bootstrapSyncDevice(
  app: TauriApp,
  input: SharedSyncBootstrap['deviceA']
): Promise<void> {
  await invokeTest(app, 'e2e_bootstrap_sync_device', { input })
}

async function waitForSyncedDeviceList(page: Page, email: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.api.syncDevices.getDevices().then((result: any) => ({
            email: result.email,
            deviceCount: result.devices.length,
            currentDeviceCount: result.devices.filter((device: any) => device.isCurrentDevice)
              .length
          }))
        ),
      { timeout: 30_000 }
    )
    .toMatchObject({ email, deviceCount: 2, currentDeviceCount: 1 })
}

export const test = base.extend<{
  syncBootstrap: SharedSyncBootstrap
  syncServerUrl: string | null
  bootstrappedSyncPair: void
}>({
  syncBootstrap: async ({}, use) => {
    const bootstrap = await startSharedSyncBootstrap()
    try {
      await use(bootstrap)
    } finally {
      await bootstrap.server.stop()
    }
  },

  syncServerUrl: async ({ syncBootstrap }, use) => {
    await use(syncBootstrap.serverUrl)
  },

  bootstrappedSyncPair: async ({ app, appB, page, pageB, syncBootstrap }, use) => {
    await bootstrapSyncDevice(app, syncBootstrap.deviceA)
    await bootstrapSyncDevice(appB, syncBootstrap.deviceB)

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await waitForAppReady(page)

    await pageB.reload()
    await pageB.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageB)

    await waitForSyncedDeviceList(page, syncBootstrap.email)
    await waitForSyncedDeviceList(pageB, syncBootstrap.email)

    await use()
  }
})

export { expect }
