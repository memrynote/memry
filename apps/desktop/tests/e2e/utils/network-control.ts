import { expect as playwrightExpect, type ElectronApplication, type Page } from '@playwright/test'

interface SyncStatusSnapshot {
  status: 'idle' | 'syncing' | 'offline' | 'error'
  pendingCount: number
  offlineSince?: number
}

interface TriggerSyncResult {
  success: boolean
  error?: string
}

interface MemryNetworkTestHooks {
  setNetworkOnlineForTests(online: boolean): Promise<void>
  getCrdtPendingCount(): Promise<number>
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

export async function readCrdtPendingCount(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(async () => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: MemryNetworkTestHooks
      }
    ).__memryTestHooks

    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }

    return hooks.getCrdtPendingCount()
  })
}

export async function readSyncStatus(page: Page): Promise<SyncStatusSnapshot> {
  return page.evaluate(() => window.api.syncOps.getStatus())
}

export async function triggerSync(page: Page): Promise<TriggerSyncResult> {
  return page.evaluate(() => window.api.syncOps.triggerSync())
}

export async function waitForSyncOffline(page: Page, timeout = 15000): Promise<SyncStatusSnapshot> {
  await playwrightExpect
    .poll(() => readSyncStatus(page), { timeout })
    .toMatchObject({ status: 'offline' })

  return readSyncStatus(page)
}

export async function waitForSyncOnline(page: Page, timeout = 15000): Promise<SyncStatusSnapshot> {
  await playwrightExpect
    .poll(
      async () => {
        const status = await readSyncStatus(page)
        return (
          (status.status === 'idle' || status.status === 'syncing') && status.offlineSince == null
        )
      },
      { timeout }
    )
    .toBe(true)

  return readSyncStatus(page)
}

export async function waitForPendingCount(
  page: Page,
  expectedPendingCount: number,
  timeout = 15000
): Promise<SyncStatusSnapshot> {
  await playwrightExpect
    .poll(
      async () => {
        const status = await readSyncStatus(page)
        return status.pendingCount
      },
      { timeout }
    )
    .toBe(expectedPendingCount)

  return readSyncStatus(page)
}

export async function waitForSyncIdle(page: Page, timeout = 15000): Promise<SyncStatusSnapshot> {
  await playwrightExpect
    .poll(
      async () => {
        const status = await readSyncStatus(page)
        return status.status === 'idle' && status.pendingCount === 0 && status.offlineSince == null
      },
      { timeout }
    )
    .toBe(true)

  return readSyncStatus(page)
}

export async function syncAndWait(page: Page, timeout = 15000): Promise<SyncStatusSnapshot> {
  const trigger = await triggerSync(page)

  if (!trigger.success) {
    throw new Error(trigger.error || 'Sync trigger failed')
  }

  return waitForSyncIdle(page, timeout)
}

export async function waitForCrdtQueueIdle(
  electronApp: ElectronApplication,
  timeout = 15000
): Promise<number> {
  await playwrightExpect.poll(() => readCrdtPendingCount(electronApp), { timeout }).toBe(0)

  return readCrdtPendingCount(electronApp)
}

export async function syncBothAndWait(
  pageA: Page,
  pageB: Page,
  timeout = 15000
): Promise<{ statusA: SyncStatusSnapshot; statusB: SyncStatusSnapshot }> {
  // A single parallel trigger is racy for cross-device note propagation: one page can
  // pull before the other page has pushed its latest note record. Run a round-trip sync
  // so both devices observe the other's latest state deterministically.
  await syncAndWait(pageA, timeout)
  const statusB = await syncAndWait(pageB, timeout)
  const statusA = await syncAndWait(pageA, timeout)

  return { statusA, statusB }
}
