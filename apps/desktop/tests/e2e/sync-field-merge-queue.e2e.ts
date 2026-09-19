import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  goOffline,
  goOnline,
  readSyncStatus,
  triggerSync,
  waitForPendingCount,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'
import type { SharedSyncBootstrap } from './utils/sync-backend'

const SYNC_TIMEOUT = 60_000
const CONVERGENCE_TIMEOUT = 120_000

async function getProjectById(page: Page, id: string) {
  return page.evaluate((projectId) => window.api.tasks.getProject(projectId), id)
}

async function getNoteById(page: Page, id: string) {
  return page.evaluate((noteId) => window.api.notes.get(noteId), id)
}

async function readServerNoteTombstone(
  syncBootstrap: SharedSyncBootstrap,
  noteId: string
): Promise<{ operation: string; deleted_at: number | null } | null> {
  const db = await syncBootstrap.server.getD1()
  return db
    .prepare(
      `SELECT operation, deleted_at
       FROM sync_items
       WHERE item_type = 'note' AND item_id = ?`
    )
    .bind(noteId)
    .first<{ operation: string; deleted_at: number | null }>()
}

async function triggerSyncOrThrow(page: Page): Promise<void> {
  const result = await triggerSync(page)
  if (!result.success) {
    throw new Error(result.error || 'Sync trigger failed')
  }
}

async function triggerSyncRound(pageA: Page, pageB: Page): Promise<void> {
  await triggerSyncOrThrow(pageA)
  await triggerSyncOrThrow(pageB)
  await triggerSyncOrThrow(pageA)
}

async function expectProjectOnBothDevices(
  pageA: Page,
  pageB: Page,
  id: string,
  expected: Record<string, unknown>
): Promise<void> {
  await expect
    .poll(
      async () => {
        await triggerSyncRound(pageA, pageB)
        return {
          pageA: await getProjectById(pageA, id),
          pageB: await getProjectById(pageB, id)
        }
      },
      { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
    )
    .toMatchObject({
      pageA: expected,
      pageB: expected
    })
}

async function expectProjectDescriptionConverges(
  pageA: Page,
  pageB: Page,
  id: string,
  acceptedDescriptions: string[]
): Promise<void> {
  await expect
    .poll(
      async () => {
        await triggerSyncRound(pageA, pageB)
        const pageAProject = await getProjectById(pageA, id)
        const pageBProject = await getProjectById(pageB, id)
        const pageADescription = pageAProject?.description ?? null
        const pageBDescription = pageBProject?.description ?? null

        return {
          pageADescription,
          pageBDescription,
          converged: pageADescription === pageBDescription,
          accepted: acceptedDescriptions.includes(pageADescription ?? '')
        }
      },
      { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
    )
    .toMatchObject({ converged: true, accepted: true })
}

test.describe('Sync field merge and queue retry E2E', () => {
  test.setTimeout(240_000)

  test('merges offline project fields and flushes queued task work after reconnect', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    const seed = await pageA.evaluate(async () => {
      const projectResult = await window.api.tasks.createProject({
        name: `Merge Project ${Date.now()}`,
        description: 'Initial project description',
        color: '#3b82f6',
        icon: 'FolderKanban',
        statuses: [
          { name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 },
          { name: 'Done', color: '#10b981', type: 'done', order: 1 }
        ]
      })
      if (!projectResult.success || !projectResult.project) {
        throw new Error(projectResult.error ?? 'project create failed')
      }

      return {
        projectId: projectResult.project.id
      }
    })

    await expectProjectOnBothDevices(pageA, pageB, seed.projectId, {
      description: 'Initial project description'
    })

    await goOffline(electronAppA, electronAppB)
    await Promise.all([waitForSyncOffline(pageA), waitForSyncOffline(pageB)])
    await pageA.evaluate(() => window.api.quickCapture.openSettings('account'))
    await expect(pageA.getByRole('dialog')).toBeVisible()
    await expect(pageA.getByText(/^Offline/).first()).toBeVisible()

    await pageA.evaluate(async ({ projectId }) => {
      await window.api.tasks.updateProject({
        id: projectId,
        name: 'Project name from A',
        description: 'Project description from A'
      })
    }, seed)

    await pageB.evaluate(async ({ projectId }) => {
      await window.api.tasks.updateProject({
        id: projectId,
        color: '#f97316',
        icon: 'Rocket'
      })
    }, seed)

    await expect.poll(async () => (await readSyncStatus(pageA)).pendingCount > 0).toBe(true)
    await expect.poll(async () => (await readSyncStatus(pageB)).pendingCount > 0).toBe(true)

    await goOnline(electronAppA, electronAppB)

    await expectProjectOnBothDevices(pageA, pageB, seed.projectId, {
      name: 'Project name from A',
      description: 'Project description from A',
      color: '#f97316',
      icon: 'Rocket'
    })

    await waitForPendingCount(pageA, 0, SYNC_TIMEOUT)
    await waitForPendingCount(pageB, 0, SYNC_TIMEOUT)

    await goOffline(electronAppA, electronAppB)
    await Promise.all([waitForSyncOffline(pageA), waitForSyncOffline(pageB)])

    await pageA.evaluate(async ({ projectId }) => {
      await window.api.tasks.updateProject({
        id: projectId,
        description: 'Same field from A'
      })
    }, seed)

    await pageB.evaluate(async ({ projectId }) => {
      await window.api.tasks.updateProject({
        id: projectId,
        description: 'Same field from B'
      })
    }, seed)

    await expect.poll(async () => (await readSyncStatus(pageA)).pendingCount > 0).toBe(true)
    await expect.poll(async () => (await readSyncStatus(pageB)).pendingCount > 0).toBe(true)

    await goOnline(electronAppA, electronAppB)

    await expectProjectDescriptionConverges(pageA, pageB, seed.projectId, [
      'Same field from A',
      'Same field from B'
    ])

    await waitForPendingCount(pageA, 0, SYNC_TIMEOUT)
    await waitForPendingCount(pageB, 0, SYNC_TIMEOUT)

    await goOffline(electronAppA)
    await waitForSyncOffline(pageA)

    const queuedTitle = `Queued retry task ${Date.now()}`
    await pageA.evaluate(
      async ({ projectId, title }) => {
        const result = await window.api.tasks.create({
          projectId,
          title,
          description: 'created while offline'
        })
        if (!result.success || !result.task) {
          throw new Error(result.error ?? 'queued task create failed')
        }
      },
      { projectId: seed.projectId, title: queuedTitle }
    )

    await expect.poll(async () => (await readSyncStatus(pageA)).pendingCount > 0).toBe(true)

    await goOnline(electronAppA)

    await expect
      .poll(
        async () => {
          await triggerSyncRound(pageA, pageB)
          return pageB.evaluate(
            async ({ projectId, title }) => {
              const result = await window.api.tasks.list({
                projectId,
                includeCompleted: true,
                includeArchived: true,
                search: title,
                limit: 20
              })
              return result.tasks.map((task) => task.title)
            },
            { projectId: seed.projectId, title: queuedTitle }
          )
        },
        { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
      )
      .toContain(queuedTitle)

    await waitForPendingCount(pageA, 0, SYNC_TIMEOUT)
  })

  test('tombstones a deleted note and keeps the tombstone over an offline device update', async ({
    electronAppB,
    pageA,
    pageB,
    syncBootstrap,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    const originalTitle = `Deleted Note ${Date.now()}`
    const staleTitle = `${originalTitle} Stale Rename`
    const seed = await pageA.evaluate(async (title) => {
      const result = await window.api.notes.create({
        title,
        content: 'Body that proves this note was created before the tombstone.'
      })
      if (!result.success || !result.note) {
        throw new Error(result.error ?? 'note create failed')
      }
      return { noteId: result.note.id, title: result.note.title }
    }, originalTitle)

    await expect
      .poll(
        async () => {
          await triggerSyncRound(pageA, pageB)
          return getNoteById(pageB, seed.noteId)
        },
        { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
      )
      .toMatchObject({ title: seed.title })

    await goOffline(electronAppB)
    await waitForSyncOffline(pageB)

    const deleteResult = await pageA.evaluate(
      (noteId) => window.api.notes.delete(noteId),
      seed.noteId
    )
    expect(deleteResult.success).toBe(true)
    await triggerSyncOrThrow(pageA)

    await expect
      .poll(
        async () => {
          await triggerSyncOrThrow(pageA)
          return readServerNoteTombstone(syncBootstrap, seed.noteId)
        },
        { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
      )
      .toMatchObject({
        operation: 'delete',
        deleted_at: expect.any(Number)
      })

    const renameResult = await pageB.evaluate(
      ({ noteId, title }) => window.api.notes.rename(noteId, title),
      { noteId: seed.noteId, title: staleTitle }
    )
    expect(renameResult.success).toBe(true)
    await expect.poll(async () => (await readSyncStatus(pageB)).pendingCount > 0).toBe(true)

    await goOnline(electronAppB)
    await expect
      .poll(
        async () => {
          await triggerSyncOrThrow(pageB)
          return readServerNoteTombstone(syncBootstrap, seed.noteId)
        },
        { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
      )
      .toMatchObject({
        operation: 'delete',
        deleted_at: expect.any(Number)
      })

    // Delete wins: a writer that never saw the tombstone cannot resurrect the id
    // (`shouldRejectResurrection`, apps/sync-server/src/services/sync.ts), so the
    // deleting device stays deleted and the stale rename never comes back.
    //
    // Device B must converge too (#2198): its push is refused forever with
    // SYNC_DELETE_WINS, so a client that kept the locally-renamed note would
    // hold a ghost copy of an item deleted everywhere else.
    await expect
      .poll(
        async () => {
          await triggerSyncRound(pageA, pageB)
          return (await getNoteById(pageA, seed.noteId))?.id ?? null
        },
        { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
      )
      .toBeNull()

    await expect
      .poll(
        async () => {
          await triggerSyncRound(pageA, pageB)
          return (await getNoteById(pageB, seed.noteId))?.id ?? null
        },
        { timeout: CONVERGENCE_TIMEOUT, intervals: [500, 2_000, 5_000] }
      )
      .toBeNull()
  })
})
