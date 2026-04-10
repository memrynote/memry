import { test, expect } from './fixtures/sync-auth-fixtures'
import { createNoteWithBody, expectNoteBody, openNoteByTitle } from './utils/note-sync-helpers'
import { syncBothAndWait, waitForSyncOnline } from './utils/network-control'

test.describe('Manual sync smoke', () => {
  test('A creates online, both trigger sync, B reaches idle and opens the note', async ({
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `H5 Sync Smoke ${Date.now()}`
    const body = 'manual sync line 1\n\nmanual sync line 2'

    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

    await createNoteWithBody(pageA, title, body)

    const { statusA, statusB } = await syncBothAndWait(pageA, pageB)

    expect(statusA.pendingCount).toBe(0)
    expect(statusB.pendingCount).toBe(0)

    await openNoteByTitle(pageB, title)
    await expectNoteBody(pageB, body)
  })
})
