import { test, expect } from './fixtures/sync-fixtures'
import { waitForVaultReady } from './utils/electron-helpers'
import { createNoteWithBody, expectNoteBody, openNoteByTitle } from './utils/note-sync-helpers'

test.describe('Note sync helpers smoke', () => {
  test('can create, reopen, and read exact note body on both devices', async ({ pageA, pageB }) => {
    const now = Date.now()
    const noteA = {
      title: `H4 Device A ${now}`,
      body: 'alpha line 1\n\nalpha line 2'
    }
    const noteB = {
      title: `H4 Device B ${now}`,
      body: 'beta line 1\n\nbeta line 2'
    }

    await Promise.all([waitForVaultReady(pageA), waitForVaultReady(pageB)])

    await createNoteWithBody(pageA, noteA.title, noteA.body)
    await createNoteWithBody(pageA, `${noteA.title} Decoy`, 'decoy')
    await createNoteWithBody(pageB, noteB.title, noteB.body)
    await createNoteWithBody(pageB, `${noteB.title} Decoy`, 'decoy')

    await openNoteByTitle(pageA, noteA.title)
    await openNoteByTitle(pageB, noteB.title)

    await expectNoteBody(pageA, noteA.body)
    await expectNoteBody(pageB, noteB.body)
  })
})
