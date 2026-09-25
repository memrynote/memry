import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures/sync-auth-fixtures'
import {
  destroyLaunchedElectron,
  launchElectronWithWindow,
  type LaunchedElectron
} from './utils/electron-lifecycle'
import {
  triggerSync,
  waitForPendingCount,
  waitForSyncIdle,
  waitForSyncOnline
} from './utils/network-control'
import { startSyncProxy, type SyncProxy } from './utils/sync-proxy'

/**
 * #2300 live lane: two desktop instances on one account against the real
 * Worker in Miniflare. Only device B talks through the recording proxy, and it
 * opts in to socket items on its handshake. After B is caught up, every
 * `/sync/changes` and `/sync/pull` response B asks for is cut before its first
 * byte, so the only route A's edit has to B is the `changes_available` frame.
 */

const SYNC_TIMEOUT = 60_000

const test = base.extend<{ proxyB: SyncProxy }>({
  proxyB: async ({ syncBootstrap }, use) => {
    const proxy = await startSyncProxy(syncBootstrap.serverUrl, { forwardWebSocket: true })
    try {
      await use(proxy)
    } finally {
      await proxy.close()
    }
  },

  electronAppB: async ({ deviceIdB, vaultPathB, proxyB }, use) => {
    const launched = await launchElectronWithWindow({
      testVaultPath: vaultPathB,
      deviceId: deviceIdB,
      syncServerUrl: proxyB.url
    })
    ;(launched.app as unknown as { __launched?: LaunchedElectron }).__launched = launched
    await use(launched.app)
    await destroyLaunchedElectron(launched)
  }
})

async function triggerSyncOrThrow(page: Page): Promise<void> {
  const result = await triggerSync(page)
  if (!result.success) throw new Error(result.error || 'Sync trigger failed')
}

async function taskTitle(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (taskId) => (await window.api.tasks.get(taskId))?.title ?? null, id)
}

const isPullTransport = (method: string, pathname: string): boolean =>
  (method === 'GET' && pathname === '/sync/changes') ||
  (method === 'POST' && pathname === '/sync/pull')

test.describe('Sync socket items (#2300)', () => {
  test.setTimeout(240_000)

  test('a peer edit applies from the socket frame with no HTTP pull delivering it', async ({
    pageA,
    pageB,
    proxyB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    const taskId = await pageA.evaluate(async () => {
      const project = await window.api.tasks.createProject({
        name: `Socket items ${Date.now()}`,
        color: '#3b82f6',
        icon: 'FolderKanban',
        statuses: [
          { name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 },
          { name: 'Done', color: '#10b981', type: 'done', order: 1 }
        ]
      })
      if (!project.success || !project.project) throw new Error(project.error ?? 'project failed')
      const task = await window.api.tasks.create({
        projectId: project.project.id,
        title: 'Before edit'
      })
      if (!task.success || !task.task) throw new Error(task.error ?? 'task failed')
      return task.task.id
    })
    await expect
      .poll(
        async () => {
          await triggerSyncOrThrow(pageA)
          await triggerSyncOrThrow(pageB)
          return taskTitle(pageB, taskId)
        },
        { timeout: SYNC_TIMEOUT, intervals: [500, 2_000] }
      )
      .toBe('Before edit')

    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)
    expect(proxyB.requests({ pathPrefix: '/sync/ws' }).length).toBeGreaterThan(0)

    // From here no HTTP pull of B's can deliver anything.
    proxyB.injectFault({ match: isPullTransport, afterBytes: 0, maxHits: 1_000 })
    const mark = proxyB.records.length
    await pageA.evaluate(async (id) => {
      const result = await window.api.tasks.update({ id, title: 'Edited on A' })
      if (!result.success) throw new Error(result.error ?? 'task update failed')
    }, taskId)
    await waitForPendingCount(pageA, 0, SYNC_TIMEOUT)

    await expect
      .poll(() => taskTitle(pageB, taskId), { timeout: SYNC_TIMEOUT, intervals: [250, 1_000] })
      .toBe('Edited on A')

    const sinceEdit = proxyB.records.slice(mark)
    const pullAttempts = sinceEdit.filter((entry) => isPullTransport(entry.method, entry.path))
    // Status 0 is a request still waiting on its (to be severed) response.
    const deliveredPulls = pullAttempts.filter((entry) => entry.status !== 0 && !entry.severed)
    console.log(
      `[socket-items] B after A's edit: pull attempts=${pullAttempts.length} ` +
        `delivered=${deliveredPulls.length}`
    )

    // The wake pull still ran (it always does); none of its responses arrived.
    expect(pullAttempts.length).toBeGreaterThan(0)
    expect(deliveredPulls).toHaveLength(0)
    proxyB.clearFaults()
  })
})
