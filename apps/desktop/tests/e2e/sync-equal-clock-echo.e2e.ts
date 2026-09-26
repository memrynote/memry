import path from 'node:path'
import { createRequire } from 'node:module'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  triggerSync,
  waitForPendingCount,
  waitForSyncIdle,
  waitForSyncOnline
} from './utils/network-control'

/**
 * #2294 live lane: two desktop instances on one account against the real
 * Worker in Miniflare.
 *
 * (a) The change feed serves a device its own pushes back. B creates tasks,
 *     pushes them and pulls them back: each echoed row arrives with an equal
 *     clock and an identical payload, so it must not be re-applied (counted as
 *     `tasks:updated` sends to B's windows).
 * (b) An equal clock with a DIFFERENT payload must still apply (protocol 06
 *     §6.5.2 P4). B's copy of one task is diverged under the same clock (the
 *     state a device is left in when its merge re-push is refused as a replay),
 *     B's cursor is reset, and the re-pulled server row must overwrite it.
 */

const SYNC_TIMEOUT = 60_000
const TASKS = 5
// The Electron main bundle does not resolve packages from its own require, so
// hand it the path of the Electron-built better-sqlite3 this test runs against.
const BETTER_SQLITE3 = createRequire(__filename).resolve('better-sqlite3')

async function triggerSyncOrThrow(page: Page): Promise<void> {
  const result = await triggerSync(page)
  if (!result.success) throw new Error(result.error || 'Sync trigger failed')
}

/** Count `tasks:updated` sends per task id on every window of the app. */
async function recordTaskUpdates(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const store = globalThis as typeof globalThis & { __pr14Updates?: Record<string, number> }
    store.__pr14Updates = {}
    for (const win of BrowserWindow.getAllWindows()) {
      const contents = win.webContents as typeof win.webContents & { __pr14Patched?: boolean }
      if (contents.__pr14Patched) continue
      contents.__pr14Patched = true
      const send = contents.send.bind(contents)
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === 'tasks:updated') {
          const id = (args[0] as { id?: string } | undefined)?.id ?? '?'
          const counts = store.__pr14Updates ?? {}
          counts[id] = (counts[id] ?? 0) + 1
          store.__pr14Updates = counts
        }
        send(channel, ...args)
      }
    }
  })
}

async function readTaskUpdates(app: ElectronApplication): Promise<Record<string, number>> {
  return app.evaluate(
    () =>
      (globalThis as typeof globalThis & { __pr14Updates?: Record<string, number> })
        .__pr14Updates ?? {}
  )
}

/**
 * Rewrite B's data.db through a second connection: the task title changes
 * with its clock untouched, and the pull cursor goes back to 0.
 */
async function divergeUnderSameClock(
  app: ElectronApplication,
  dataDbPath: string,
  taskId: string
): Promise<void> {
  await app.evaluate(
    (_electron, { dataDbPath, taskId, driver }) => {
      const load = (process as unknown as { mainModule: { require: (id: string) => unknown } })
        .mainModule.require
      const Database = load(driver) as new (file: string) => {
        prepare: (sql: string) => { run: (...args: unknown[]) => void }
        close: () => void
      }
      const db = new Database(dataDbPath)
      try {
        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Diverged on B', taskId)
        db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'lastCursor'").run()
      } finally {
        db.close()
      }
    },
    { dataDbPath, taskId, driver: BETTER_SQLITE3 }
  )
}

async function taskTitle(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (taskId) => (await window.api.tasks.get(taskId))?.title ?? null, id)
}

test.describe('Sync equal clock (#2294)', () => {
  test.setTimeout(240_000)

  test('own rows pulled back are not re-applied; an equal clock with other content applies', async ({
    pageA,
    pageB,
    electronAppB,
    vaultPathB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    const taskIds = await pageB.evaluate(async (count) => {
      const project = await window.api.tasks.createProject({
        name: `Equal clock ${Date.now()}`,
        color: '#3b82f6',
        icon: 'FolderKanban',
        statuses: [
          { name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 },
          { name: 'Done', color: '#10b981', type: 'done', order: 1 }
        ]
      })
      if (!project.success || !project.project) throw new Error(project.error ?? 'project failed')
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const task = await window.api.tasks.create({
          projectId: project.project.id,
          title: `Echo ${i}`
        })
        if (!task.success || !task.task) throw new Error(task.error ?? 'task failed')
        ids.push(task.task.id)
      }
      return ids
    }, TASKS)

    // (a) Mark after B's own writes, then push and pull them back.
    await recordTaskUpdates(electronAppB)
    await triggerSyncOrThrow(pageB)
    await waitForPendingCount(pageB, 0, SYNC_TIMEOUT)
    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)
    await expect
      .poll(async () => taskTitle(pageA, taskIds[0]), {
        timeout: SYNC_TIMEOUT,
        intervals: [500, 2_000]
      })
      .toBe('Echo 0')

    const echoUpdates = await readTaskUpdates(electronAppB)
    const echoApplied = taskIds.reduce((sum, id) => sum + (echoUpdates[id] ?? 0), 0)
    console.log(
      `[equal-clock] (a) tasks:updated on B for its own ${TASKS} echoed rows: ${echoApplied}`
    )

    // (b) Diverge one task under the same clock and re-pull everything.
    await divergeUnderSameClock(
      electronAppB,
      path.join(vaultPathB, '.memry', 'data.db'),
      taskIds[0]
    )
    expect(await taskTitle(pageB, taskIds[0])).toBe('Diverged on B')
    await recordTaskUpdates(electronAppB)
    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)

    const repullUpdates = await readTaskUpdates(electronAppB)
    const divergedApplied = repullUpdates[taskIds[0]] ?? 0
    const identicalApplied = taskIds.slice(1).reduce((sum, id) => sum + (repullUpdates[id] ?? 0), 0)
    const repulledTitle = await taskTitle(pageB, taskIds[0])
    console.log(
      `[equal-clock] (b) after cursor reset: diverged row tasks:updated=${divergedApplied} ` +
        `title=${JSON.stringify(repulledTitle)}; identical rows tasks:updated=${identicalApplied}`
    )

    expect(repulledTitle).toBe('Echo 0')
    expect(divergedApplied).toBeGreaterThan(0)
    expect(echoApplied).toBe(0)
    expect(identicalApplied).toBe(0)
  })
})
