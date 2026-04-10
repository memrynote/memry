import { expect as playwrightExpect, type ElectronApplication, type Page } from '@playwright/test'

interface SyncStatusSnapshot {
  status: 'idle' | 'syncing' | 'offline' | 'error'
  pendingCount: number
  offlineSince?: number
}

interface MemryNetworkTestHooks {
  setNetworkOnlineForTests(online: boolean): Promise<void>
}

async function setNetworkOnlineForTests(
  electronApp: ElectronApplication,
  online: boolean
): Promise<void> {
  await electronApp.evaluate(async (_context, requestedOnline) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: MemryNetworkTestHooks
      }
    ).__memryTestHooks

    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }

    await hooks.setNetworkOnlineForTests(requestedOnline)
  }, online)
}

export async function goOffline(...apps: ElectronApplication[]): Promise<void> {
  await Promise.all(apps.map((app) => setNetworkOnlineForTests(app, false)))
}

export async function goOnline(...apps: ElectronApplication[]): Promise<void> {
  await Promise.all(apps.map((app) => setNetworkOnlineForTests(app, true)))
}

export async function readSyncStatus(page: Page): Promise<SyncStatusSnapshot> {
  return page.evaluate(() => window.api.syncOps.getStatus())
}

export async function waitForSyncOffline(page: Page, timeout = 15000): Promise<SyncStatusSnapshot> {
  await playwrightExpect
    .poll(() => readSyncStatus(page), { timeout })
    .toMatchObject({ status: 'offline' })

  return readSyncStatus(page)
}

export async function waitForSyncOnline(page: Page, timeout = 15000): Promise<SyncStatusSnapshot> {
  await playwrightExpect
    .poll(async () => {
      const status = await readSyncStatus(page)
      return (
        (status.status === 'idle' || status.status === 'syncing') &&
        status.offlineSince == null
      )
    }, { timeout })
    .toBe(true)

  return readSyncStatus(page)
}
