// Port of apps/desktop/tests/e2e/sync-equal-clock-echo.e2e.ts (#2294). Electron counted the main
// process's `tasks:updated` sends to B's windows. Here a pulled task reaches the renderer as an
// item of `sync-item-synced-event` and a local write as `task-updated-event`, so B's page counts
// both per task id. Electron diverged B's `tasks` row through a second connection; the Tauri
// store keeps the push payload in `sync_items` and projects it into `tasks`, so the divergence
// rewrites the title in both (in `.memry/core/data.db`), clocks untouched, and resets the record
// cursor in `sync_cursors`.
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test } from '../../fixtures/sync-auth-fixtures'
import {
  triggerSync,
  waitForPendingCount,
  waitForSyncIdle,
  waitForSyncOnline
} from '../../harness/network-control'
import type { Page } from '../../harness/pw-compat/page'
import { createTask, createTaskProject, taskTitle } from '../../harness/tasks'

const SYNC_TIMEOUT = 60_000
const TASKS = 5

async function triggerSyncOrThrow(page: Page): Promise<void> {
  const result = await triggerSync(page)
  if (!result.success) throw new Error(result.error || `Sync trigger failed: ${result.reason}`)
}

interface TaskUpdateWindow {
  __taskUpdates?: Record<string, number>
  __taskUpdatesListening?: boolean
  __TAURI__: {
    event: {
      listen(name: string, cb: (event: { payload: unknown }) => void): Promise<unknown>
    }
  }
}

/** Starts (or restarts) counting task announcements per task id on the page. */
async function recordTaskUpdates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as TaskUpdateWindow
    target.__taskUpdates = {}
    if (target.__taskUpdatesListening) return true
    target.__taskUpdatesListening = true
    const count = (id: string): void => {
      const counts = target.__taskUpdates ?? {}
      counts[id] = (counts[id] ?? 0) + 1
      target.__taskUpdates = counts
    }
    const { listen } = target.__TAURI__.event
    return Promise.all([
      listen('task-updated-event', (event) => count((event.payload as { id: string }).id)),
      listen('sync-item-synced-event', (event) => {
        const payload = event.payload as {
          operation: string
          items: { itemId: string; type: string }[]
        }
        if (payload.operation !== 'pull') return
        for (const item of payload.items) if (item.type === 'task') count(item.itemId)
      })
    ]).then(() => true)
  })
}

async function readTaskUpdates(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (window as unknown as TaskUpdateWindow).__taskUpdates ?? {})
}

/**
 * Rewrites B's `data.db` through a second connection: the task title changes with its clock
 * untouched, and the record cursor goes back to 0.
 */
function divergeUnderSameClock(dataDbPath: string, taskId: string): void {
  const db = new DatabaseSync(dataDbPath)
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    db.prepare(
      "UPDATE sync_items SET payload = json_set(payload, '$.title', ?) WHERE item_type = 'task' AND item_id = ?"
    ).run('Diverged on B', taskId)
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Diverged on B', taskId)
    db.prepare("UPDATE sync_cursors SET cursor = '0' WHERE scope = 'record'").run()
  } finally {
    db.close()
  }
}

test.describe('Sync equal clock (#2294)', () => {
  test('own rows pulled back are not re-applied; an equal clock with other content applies', async ({
    page,
    pageB,
    vaultPathB,
    bootstrappedSyncPair: _bootstrappedSyncPair
  }) => {
    test.setTimeout(240_000)
    await Promise.all([waitForSyncOnline(page), waitForSyncOnline(pageB)])

    const projectId = await createTaskProject(pageB, `Equal clock ${Date.now()}`)
    const taskIds: string[] = []
    for (let i = 0; i < TASKS; i++) taskIds.push(await createTask(pageB, projectId, `Echo ${i}`))

    // (a) Mark after B's own writes, then push and pull them back.
    await recordTaskUpdates(pageB)
    await triggerSyncOrThrow(pageB)
    await waitForPendingCount(pageB, 0, SYNC_TIMEOUT)
    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)
    await expect
      .poll(async () => taskTitle(page, taskIds[0]), {
        timeout: SYNC_TIMEOUT,
        intervals: [500, 2_000]
      })
      .toBe('Echo 0')

    const echoUpdates = await readTaskUpdates(pageB)
    const echoApplied = taskIds.reduce((sum, id) => sum + (echoUpdates[id] ?? 0), 0)
    console.log(
      `[equal-clock] (a) task updates on B for its own ${TASKS} echoed rows: ${echoApplied}`
    )

    // (b) Diverge one task under the same clock and re-pull everything.
    divergeUnderSameClock(join(vaultPathB, '.memry', 'core', 'data.db'), taskIds[0])
    expect(await taskTitle(pageB, taskIds[0])).toBe('Diverged on B')
    await recordTaskUpdates(pageB)
    await triggerSyncOrThrow(pageB)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)

    const repullUpdates = await readTaskUpdates(pageB)
    const divergedApplied = repullUpdates[taskIds[0]] ?? 0
    const identicalApplied = taskIds.slice(1).reduce((sum, id) => sum + (repullUpdates[id] ?? 0), 0)
    const repulledTitle = await taskTitle(pageB, taskIds[0])
    console.log(
      `[equal-clock] (b) after cursor reset: diverged row updates=${divergedApplied} ` +
        `title=${JSON.stringify(repulledTitle)}; identical rows updates=${identicalApplied}`
    )

    expect(repulledTitle).toBe('Echo 0')
    expect(divergedApplied).toBeGreaterThan(0)
    expect(echoApplied).toBe(0)
    expect(identicalApplied).toBe(0)
  })
})
