import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import { triggerSync, waitForPendingCount, waitForSyncOnline } from './utils/network-control'

/**
 * #2283 live lane: two desktop instances on one account against the real
 * Worker in Miniflare. A's socket is dropped first so no `changes_available`
 * wake pulls B's rows before A pushes; with the socket up the test passes even
 * with the bug.
 */

const SYNC_TIMEOUT = 60_000
const PEER_TASKS = 6

interface CursorSkipHooks {
  disconnectSyncSocketForTests(): Promise<void>
  getSyncStateValueForTests(key: string): Promise<string | null>
}

function callHook<K extends keyof CursorSkipHooks>(
  app: ElectronApplication,
  name: K,
  ...args: Parameters<CursorSkipHooks[K]>
): Promise<Awaited<ReturnType<CursorSkipHooks[K]>>> {
  return app.evaluate(
    async (_context, { name, args }) => {
      const hooks = (globalThis as typeof globalThis & { __memryTestHooks?: CursorSkipHooks })
        .__memryTestHooks
      if (!hooks) throw new Error('Memry test hooks are not registered')
      const hook = hooks[name] as (...a: unknown[]) => Promise<unknown>
      return hook(...args)
    },
    { name, args }
  ) as Promise<Awaited<ReturnType<CursorSkipHooks[K]>>>
}

async function createTask(page: Page, projectId: string, title: string): Promise<string> {
  return page.evaluate(
    async ({ projectId, title }) => {
      const result = await window.api.tasks.create({ projectId, title })
      if (!result.success || !result.task) throw new Error(result.error ?? 'task create failed')
      return result.task.id
    },
    { projectId, title }
  )
}

async function presentTaskIds(page: Page, ids: string[]): Promise<string[]> {
  const found = await page.evaluate(
    async (taskIds) =>
      Promise.all(taskIds.map(async (id) => ((await window.api.tasks.get(id)) ? id : null))),
    ids
  )
  return found.filter((id): id is string => id !== null)
}

async function triggerSyncOrThrow(page: Page): Promise<void> {
  const result = await triggerSync(page)
  if (!result.success) throw new Error(result.error || 'Sync trigger failed')
}

test.describe('Sync cursor skip (#2283)', () => {
  test.setTimeout(240_000)

  test('a peer range unpulled when this device pushes still reaches it', async ({
    electronAppA,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    const projectId = await pageA.evaluate(async () => {
      const result = await window.api.tasks.createProject({
        name: `Cursor skip ${Date.now()}`,
        color: '#3b82f6',
        icon: 'FolderKanban',
        statuses: [
          { name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 },
          { name: 'Done', color: '#10b981', type: 'done', order: 1 }
        ]
      })
      if (!result.success || !result.project) throw new Error(result.error ?? 'project failed')
      return result.project.id
    })
    await expect
      .poll(
        async () => {
          await triggerSyncOrThrow(pageA)
          await triggerSyncOrThrow(pageB)
          return pageB.evaluate((id) => window.api.tasks.getProject(id), projectId)
        },
        { timeout: SYNC_TIMEOUT, intervals: [500, 2_000] }
      )
      .toBeTruthy()

    await callHook(electronAppA, 'disconnectSyncSocketForTests')
    const cursorBefore = await callHook(electronAppA, 'getSyncStateValueForTests', 'lastCursor')

    const peerIds: string[] = []
    for (let i = 0; i < PEER_TASKS; i++) {
      peerIds.push(await createTask(pageB, projectId, `From B ${i}`))
    }
    await waitForPendingCount(pageB, 0, SYNC_TIMEOUT)

    const ownId = await createTask(pageA, projectId, 'From A')
    await waitForPendingCount(pageA, 0, SYNC_TIMEOUT)
    const cursorAfterPush = await callHook(electronAppA, 'getSyncStateValueForTests', 'lastCursor')

    await triggerSyncOrThrow(pageA)
    const cursorAfterPull = await callHook(electronAppA, 'getSyncStateValueForTests', 'lastCursor')
    const onA = await presentTaskIds(pageA, [...peerIds, ownId])
    const onB = await presentTaskIds(pageB, [...peerIds, ownId])

    console.log(
      `[cursor-skip] A lastCursor before=${cursorBefore} afterOwnPush=${cursorAfterPush} afterPull=${cursorAfterPull}; ` +
        `tasks on A=${onA.length}/${PEER_TASKS + 1} on B=${onB.length}/${PEER_TASKS + 1}`
    )

    expect(onA.sort()).toEqual([...peerIds, ownId].sort())
  })
})
