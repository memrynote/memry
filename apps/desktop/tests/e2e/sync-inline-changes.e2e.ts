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
 * #2292 live lane: two desktop instances on one account against the real
 * Worker in Miniflare. Only device B talks through the recording proxy, so
 * every request the proxy sees is B's. A socket wake that delivers one small
 * change must apply it from the first changes page alone, with no POST
 * /sync/pull. (A manual sync is a full sync, which keeps 500-ref pages.)
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

test.describe('Sync inline changes (#2292)', () => {
  test.setTimeout(240_000)

  test('a small edit reaches the peer from its first changes page with no /sync/pull', async ({
    pageA,
    pageB,
    proxyB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    const taskId = await pageA.evaluate(async () => {
      const project = await window.api.tasks.createProject({
        name: `Inline changes ${Date.now()}`,
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

    // B is caught up: one more round drains anything still in flight before the mark.
    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)
    expect(proxyB.requests({ pathPrefix: '/sync/ws' }).length).toBeGreaterThan(0)

    // From here B is never told to sync: A's push wakes it over the socket
    // (`changes_available` -> pull), the path a live edit takes.
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
    const changesGets = sinceEdit.filter(
      (entry) => entry.method === 'GET' && entry.path === '/sync/changes'
    )
    const pullPosts = sinceEdit.filter(
      (entry) => entry.method === 'POST' && entry.path === '/sync/pull'
    )
    console.log(
      `[inline-changes] B after A's edit: GET /sync/changes=${changesGets.length} ` +
        `POST /sync/pull=${pullPosts.length}`
    )

    expect(changesGets.length).toBeGreaterThan(0)
    expect(pullPosts).toHaveLength(0)
  })
})
