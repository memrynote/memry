// Port of apps/desktop/tests/e2e/sync-inline-changes.e2e.ts (#2292). Electron routed only B
// through the recording proxy. The Tauri harness hands both instances one `syncServerUrl`, so
// both go through it and the spec keeps B's requests by the `device_id` claim the proxy reads
// from each bearer token (the socket upgrade carries one too).
import { expect, test as base } from '../../fixtures/sync-auth-fixtures'
import {
  triggerSync,
  waitForPendingCount,
  waitForSyncIdle,
  waitForSyncOnline
} from '../../harness/network-control'
import type { Page } from '../../harness/pw-compat/page'
import { startSyncProxy, type SyncProxy } from '../../harness/sync-proxy'
import { createTask, createTaskProject, taskTitle, updateTaskTitle } from '../../harness/tasks'
import { invoke } from '../../harness/vault-commands'

const SYNC_TIMEOUT = 60_000

const test = base.extend<{ syncProxy: SyncProxy; syncServerUrl: string | null }>({
  syncProxy: async ({ syncBootstrap }, use) => {
    const proxy = await startSyncProxy(syncBootstrap.serverUrl, { forwardWebSocket: true })
    try {
      await use(proxy)
    } finally {
      await proxy.close()
    }
  },

  syncServerUrl: async ({ syncProxy }, use) => {
    await use(syncProxy.url)
  }
})

async function triggerSyncOrThrow(page: Page): Promise<void> {
  const result = await triggerSync(page)
  if (!result.success) throw new Error(result.error || `Sync trigger failed: ${result.reason}`)
}

test.describe('Sync inline changes (#2292)', () => {
  test('a small edit reaches the peer from its first changes page with no /sync/pull', async ({
    page,
    pageB,
    syncProxy,
    bootstrappedSyncPair: _bootstrappedSyncPair
  }) => {
    test.setTimeout(240_000)
    await Promise.all([waitForSyncOnline(page), waitForSyncOnline(pageB)])
    const deviceB = (await invoke<{ deviceId: string | null }>(pageB, 'account_get_info')).deviceId
    expect(deviceB).toBeTruthy()
    const recordsB = (): SyncProxy['records'] =>
      syncProxy.records.filter((entry) => entry.deviceId === deviceB)

    const projectId = await createTaskProject(page, `Inline changes ${Date.now()}`)
    const taskId = await createTask(page, projectId, 'Before edit')
    await expect
      .poll(
        async () => {
          await triggerSyncOrThrow(page)
          await triggerSyncOrThrow(pageB)
          return taskTitle(pageB, taskId)
        },
        { timeout: SYNC_TIMEOUT, intervals: [500, 2_000] }
      )
      .toBe('Before edit')

    // B is caught up: one more round drains anything still in flight before the mark.
    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)
    expect(recordsB().filter((entry) => entry.path.startsWith('/sync/ws')).length).toBeGreaterThan(
      0
    )

    // From here B is never told to sync: A's push wakes it over the socket
    // (`changes_available` -> pull), the path a live edit takes.
    const mark = recordsB().length
    await updateTaskTitle(page, taskId, 'Edited on A')
    await waitForPendingCount(page, 0, SYNC_TIMEOUT)

    await expect
      .poll(() => taskTitle(pageB, taskId), { timeout: SYNC_TIMEOUT, intervals: [250, 1_000] })
      .toBe('Edited on A')

    const sinceEdit = recordsB().slice(mark)
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
