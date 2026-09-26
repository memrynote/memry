import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  appendToNoteBody,
  createNoteWithBody,
  expectNoteBody,
  getCrdtDocBodyByTitle,
  getNoteFileBodyByTitle,
  openNoteByTitle
} from './utils/note-sync-helpers'
import {
  goOffline,
  readCrdtPendingCount,
  syncBothAndWait,
  waitForCrdtQueueIdle,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'

async function restartSyncRuntime(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(async () => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: { restartSyncRuntimeForTests(): Promise<void> }
      }
    ).__memryTestHooks
    if (!hooks) throw new Error('Memry test hooks are not registered')
    await hooks.restartSyncRuntimeForTests()
  })
}

// #2298: CRDT body updates ride sync_queue as note_body rows. Two quick edits
// queued before a flush must both reach the peer, including across a sync
// runtime restart that happens before the flush.
test.describe('Body CRDT durable outbox', () => {
  test('two quick edits queued before a restart both reach the other device', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `Outbox Restart ${Date.now()}`
    const initialBody = 'shared note from A'
    const firstEdit = 'first quick edit'
    const secondEdit = 'second quick edit'
    const expectedBody = `${initialBody}\n\n${firstEdit}\n\n${secondEdit}`

    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    await createNoteWithBody(pageA, title, initialBody)
    await syncBothAndWait(pageA, pageB)
    await openNoteByTitle(pageB, title)
    await expectNoteBody(pageB, initialBody)

    // Offline pauses the outbox, so both edits stay queued and unflushed.
    await goOffline(electronAppA)
    await waitForSyncOffline(pageA)
    await openNoteByTitle(pageA, title)
    await appendToNoteBody(pageA, firstEdit)
    await appendToNoteBody(pageA, secondEdit)
    await expectNoteBody(pageA, expectedBody)
    await expect.poll(() => readCrdtPendingCount(electronAppA)).toBeGreaterThan(0)

    // The restart discards everything in memory; the rows are all that is left.
    await restartSyncRuntime(electronAppA)
    await waitForSyncOnline(pageA)
    await waitForCrdtQueueIdle(electronAppA)

    await syncBothAndWait(pageA, pageB)
    await expect.poll(() => getCrdtDocBodyByTitle(pageB, electronAppB, title)).toBe(expectedBody)
    await expect.poll(() => getNoteFileBodyByTitle(pageB, title)).toBe(expectedBody)
  })
})
