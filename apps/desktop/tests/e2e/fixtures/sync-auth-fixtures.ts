import { expect as playwrightExpect, type ElectronApplication } from '@playwright/test'
import { test as base, expect } from './sync-fixtures'
import { waitForAppReady } from '../utils/electron-helpers'
import { startSharedSyncBootstrap, type SharedSyncBootstrap } from '../utils/sync-backend'

/**
 * Bind one Electron profile to the shared sync account.
 *
 * Exported so a spec can stage devices one at a time — a FRESH-DEVICE test
 * needs A seeded and pushed before B ever authenticates, which the
 * `bootstrappedSyncPair` fixture (both devices at once) cannot express.
 */
export async function bootstrapSyncDevice(
  electronApp: ElectronApplication,
  input: SharedSyncBootstrap['deviceA']
): Promise<void> {
  await electronApp.evaluate(async (_context, bootstrapInput) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: {
          bootstrapSyncDevice(input: SharedSyncBootstrap['deviceA']): Promise<{ deviceId: string }>
        }
      }
    ).__memryTestHooks
    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }
    await hooks.bootstrapSyncDevice(bootstrapInput)
  }, input)
}

async function waitForSyncedDeviceList(
  page: Parameters<typeof waitForAppReady>[0],
  email: string
): Promise<void> {
  await playwrightExpect
    .poll(
      () =>
        page.evaluate(() => {
          return window.api.syncDevices.getDevices().then((result) => ({
            email: result.email,
            deviceCount: result.devices.length,
            currentDeviceCount: result.devices.filter((device) => device.isCurrentDevice).length
          }))
        }),
      { timeout: 30_000 }
    )
    .toMatchObject({
      email,
      deviceCount: 2,
      currentDeviceCount: 1
    })
}

export const test = base.extend<{
  syncBootstrap: SharedSyncBootstrap
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

  bootstrappedSyncPair: async (
    { electronAppA, electronAppB, pageA, pageB, syncBootstrap },
    use
  ) => {
    await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
    await bootstrapSyncDevice(electronAppB, syncBootstrap.deviceB)

    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageA)

    await pageB.reload()
    await pageB.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageB)

    await waitForSyncedDeviceList(pageA, syncBootstrap.email)
    await waitForSyncedDeviceList(pageB, syncBootstrap.email)

    await use()
  }
})

export { expect }
