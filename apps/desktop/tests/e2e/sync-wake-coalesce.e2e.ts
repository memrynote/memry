import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import { readSyncStatus, triggerSync, waitForSyncOnline } from './utils/network-control'

/**
 * #2290 live lane: two desktop instances on one account against the real
 * Worker in Miniflare. B pushes BULK_TASKS rows in normal-size requests,
 * which keeps A busy pulling, then BURST_TASKS rows one request per row, so
 * A's socket receives a burst of `changes_available` frames while it pulls.
 * Before the fix every wake queued its own serial pull; after it, wakes that
 * land while a pull is queued or running collapse into one follow-up, and a
 * wake whose cursor A has already pulled past is dropped.
 */

const SYNC_TIMEOUT = 60_000
const BULK_TASKS = 150
const BURST_TASKS = 10
const BULK_ROWS_PER_REQUEST = 100
// Long enough for any trailing pull the burst queued to finish and be counted.
const SETTLE_MS = 3_000

interface WakeProbeCounts {
  wakes: number
  pulls: number
}

interface SocketState {
  connected: boolean
  connectionGeneration: number
  errors: string[]
  internals?: Record<string, unknown>
}

interface WakeCoalesceHooks {
  pauseSyncForTests(): Promise<void>
  pushQueuedSyncRowsForTests(rowsPerRequest: number): Promise<void>
  startSyncWakeProbeForTests(): Promise<void>
  getSyncWakeProbeForTests(): Promise<WakeProbeCounts>
  getSyncSocketStateForTests(): Promise<SocketState>
}

function callHook<K extends keyof WakeCoalesceHooks>(
  app: ElectronApplication,
  name: K,
  ...args: Parameters<WakeCoalesceHooks[K]>
): Promise<Awaited<ReturnType<WakeCoalesceHooks[K]>>> {
  return app.evaluate(
    async (_context, { name, args }) => {
      const hooks = (globalThis as typeof globalThis & { __memryTestHooks?: WakeCoalesceHooks })
        .__memryTestHooks
      if (!hooks) throw new Error('Memry test hooks are not registered')
      const hook = hooks[name] as (...a: unknown[]) => Promise<unknown>
      return hook(...args)
    },
    { name, args }
  ) as Promise<Awaited<ReturnType<WakeCoalesceHooks[K]>>>
}

async function createTasks(
  page: Page,
  projectId: string,
  prefix: string,
  count: number
): Promise<string[]> {
  return page.evaluate(
    async ({ projectId, prefix, count }) => {
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const result = await window.api.tasks.create({ projectId, title: `${prefix} ${i}` })
        if (!result.success || !result.task) throw new Error(result.error ?? 'task create failed')
        ids.push(result.task.id)
      }
      return ids
    },
    { projectId, prefix, count }
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

test.describe('Sync wake coalescing (#2290)', () => {
  test.setTimeout(240_000)

  test('a burst of peer pushes costs fewer pulls than wakes and still delivers every row', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    // Attach the socket error listener early; the second call below resets the counts.
    await callHook(electronAppA, 'startSyncWakeProbeForTests')

    const projectId = await pageB.evaluate(async () => {
      const result = await window.api.tasks.createProject({
        name: `Wake coalesce ${Date.now()}`,
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
          await triggerSyncOrThrow(pageB)
          await triggerSyncOrThrow(pageA)
          return pageA.evaluate((id) => window.api.tasks.getProject(id), projectId)
        },
        { timeout: SYNC_TIMEOUT, intervals: [500, 2_000] }
      )
      .toBeTruthy()

    await callHook(electronAppA, 'startSyncWakeProbeForTests')
    // The wakes only reach A over its realtime socket. Without it this test
    // would measure the periodic pull, so wait for the socket and say why if
    // it never comes up.
    let socket: SocketState = { connected: false, connectionGeneration: 0, errors: [] }
    await expect
      .poll(
        async () => {
          socket = await callHook(electronAppA, 'getSyncSocketStateForTests')
          return socket.connected
        },
        { timeout: SYNC_TIMEOUT, intervals: [250, 1_000] }
      )
      .toBe(true)
      .catch(async (error: unknown) => {
        const status = await readSyncStatus(pageA)
        throw new Error(`A's sync socket never connected: ${JSON.stringify({ socket, status })}`, {
          cause: error
        })
      })

    // B stays paused while it queues rows, so no push debounce decides how
    // they split into requests. The bulk goes up in normal-size requests and
    // keeps A pulling; the burst follows one row per request, one wake each.
    await callHook(electronAppB, 'pauseSyncForTests')
    const bulkIds = await createTasks(pageB, projectId, 'Bulk', BULK_TASKS)
    await callHook(electronAppB, 'pushQueuedSyncRowsForTests', BULK_ROWS_PER_REQUEST)
    const burstIds = await createTasks(pageB, projectId, 'Burst', BURST_TASKS)
    await callHook(electronAppB, 'pushQueuedSyncRowsForTests', 1)
    const peerIds = [...bulkIds, ...burstIds]

    // No manual sync on A: the wakes alone must deliver every row.
    await expect
      .poll(async () => (await presentTaskIds(pageA, peerIds)).length, {
        timeout: SYNC_TIMEOUT,
        intervals: [250, 500, 1_000]
      })
      .toBe(peerIds.length)
    await pageA.waitForTimeout(SETTLE_MS)

    const { wakes, pulls } = await callHook(electronAppA, 'getSyncWakeProbeForTests')
    const onA = await presentTaskIds(pageA, peerIds)
    console.log(
      `[wake-coalesce] B pushed ${BULK_TASKS} bulk + ${BURST_TASKS} burst tasks; ` +
        `A wakes=${wakes} pulls=${pulls}; tasks on A=${onA.length}/${peerIds.length}; ` +
        `A socket generation=${socket.connectionGeneration}`
    )

    expect(wakes).toBeGreaterThanOrEqual(BURST_TASKS)
    expect(pulls).toBeGreaterThanOrEqual(1)
    expect(pulls).toBeLessThan(wakes)
  })
})
