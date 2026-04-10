import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  createNoteWithBody,
  expectNoteBody,
  getNoteFileBodyByTitle,
  openNoteByTitle
} from './utils/note-sync-helpers'
import {
  goOffline,
  goOnline,
  syncBothAndWait,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'
import type { ElectronApplication, Page } from '@playwright/test'

async function noteExists(
  page: Parameters<typeof openNoteByTitle>[0],
  title: string
): Promise<boolean> {
  return page.evaluate(async (expectedTitle) => {
    const result = await window.api.notes.list({})
    return result.notes.some((note) => note.title === expectedTitle)
  }, title)
}

async function runOfflineCreatePropagationCase({
  offlineApp,
  creatorPage,
  receiverPage,
  title,
  body
}: {
  offlineApp: ElectronApplication
  creatorPage: Page
  receiverPage: Page
  title: string
  body: string
}): Promise<void> {
  await Promise.all([waitForSyncOnline(creatorPage), waitForSyncOnline(receiverPage)])

  await goOffline(offlineApp)
  await waitForSyncOffline(creatorPage)

  await createNoteWithBody(creatorPage, title, body)

  expect(await noteExists(creatorPage, title)).toBe(true)
  expect(await noteExists(receiverPage, title)).toBe(false)

  await goOnline(offlineApp)
  await waitForSyncOnline(creatorPage)

  await syncBothAndWait(creatorPage, receiverPage)

  expect(await getNoteFileBodyByTitle(receiverPage, title)).toBe(body)

  await openNoteByTitle(receiverPage, title)
  await expectNoteBody(receiverPage, body)
}

async function runReceiverOfflineCreatePropagationCase({
  offlineApp,
  creatorPage,
  receiverPage,
  title,
  body
}: {
  offlineApp: ElectronApplication
  creatorPage: Page
  receiverPage: Page
  title: string
  body: string
}): Promise<void> {
  await Promise.all([waitForSyncOnline(creatorPage), waitForSyncOnline(receiverPage)])

  await goOffline(offlineApp)
  await waitForSyncOffline(receiverPage)

  await createNoteWithBody(creatorPage, title, body)

  expect(await noteExists(creatorPage, title)).toBe(true)
  expect(await noteExists(receiverPage, title)).toBe(false)

  await goOnline(offlineApp)
  await waitForSyncOnline(receiverPage)

  await syncBothAndWait(creatorPage, receiverPage)

  expect(await getNoteFileBodyByTitle(receiverPage, title)).toBe(body)

  await openNoteByTitle(receiverPage, title)
  await expectNoteBody(receiverPage, body)
}

test.describe('Body CRDT create propagation', () => {
  test('C1: A offline creates a note, then A reconnects and B receives the exact body', async ({
    electronAppA,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `C1 Offline Create ${Date.now()}`
    const body = 'device A offline line 1\n\ndevice A offline line 2'

    await runOfflineCreatePropagationCase({
      offlineApp: electronAppA,
      creatorPage: pageA,
      receiverPage: pageB,
      title,
      body
    })
  })

  test('C2: B offline creates a note, then B reconnects and A receives the exact body', async ({
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `C2 Offline Create ${Date.now()}`
    const body = 'device B offline line 1\n\ndevice B offline line 2'

    await runOfflineCreatePropagationCase({
      offlineApp: electronAppB,
      creatorPage: pageB,
      receiverPage: pageA,
      title,
      body
    })
  })

  test('C3: A online creates a note while B is offline, then B reconnects and receives the exact body', async ({
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `C3 Online Create ${Date.now()}`
    const body = 'device A online line 1\n\ndevice A online line 2'

    await runReceiverOfflineCreatePropagationCase({
      offlineApp: electronAppB,
      creatorPage: pageA,
      receiverPage: pageB,
      title,
      body
    })
  })

  test('C4: B online creates a note while A is offline, then A reconnects and receives the exact body', async ({
    electronAppA,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `C4 Online Create ${Date.now()}`
    const body = 'device B online line 1\n\ndevice B online line 2'

    await runReceiverOfflineCreatePropagationCase({
      offlineApp: electronAppA,
      creatorPage: pageB,
      receiverPage: pageA,
      title,
      body
    })
  })
})
