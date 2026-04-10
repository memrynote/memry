import { test, expect } from './fixtures/sync-auth-fixtures'
import type { ElectronApplication, Page } from '@playwright/test'
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
  goOnline,
  syncBothAndWait,
  waitForCrdtQueueIdle,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'

async function seedSharedNote({
  pageA,
  pageB,
  creatorPage,
  title,
  body
}: {
  pageA: Page
  pageB: Page
  creatorPage: Page
  title: string
  body: string
}): Promise<void> {
  await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

  await createNoteWithBody(creatorPage, title, body)
  await syncBothAndWait(pageA, pageB)

  await openNoteByTitle(pageA, title)
  await expectNoteBody(pageA, body)

  await openNoteByTitle(pageB, title)
  await expectNoteBody(pageB, body)
}

async function appendBodyAndPersist({
  page,
  title,
  editText,
  expectedBody
}: {
  page: Page
  title: string
  editText: string
  expectedBody: string
}): Promise<void> {
  await openNoteByTitle(page, title)
  await appendToNoteBody(page, editText)
  await expectNoteBody(page, expectedBody)
  await expect.poll(() => getNoteFileBodyByTitle(page, title)).toBe(expectedBody)
}

async function runOfflineEditorEditCase({
  pageA,
  pageB,
  creatorPage,
  editorPage,
  receiverPage,
  offlineApp,
  title,
  initialBody,
  editText
}: {
  pageA: Page
  pageB: Page
  creatorPage: Page
  editorPage: Page
  receiverPage: Page
  offlineApp: ElectronApplication
  title: string
  initialBody: string
  editText: string
}): Promise<void> {
  const expectedBody = `${initialBody}\n\n${editText}`

  await seedSharedNote({ pageA, pageB, creatorPage, title, body: initialBody })

  await goOffline(offlineApp)
  await waitForSyncOffline(editorPage)

  await appendBodyAndPersist({ page: editorPage, title, editText, expectedBody })

  await goOnline(offlineApp)
  await waitForSyncOnline(editorPage)

  await syncBothAndWait(pageA, pageB)

  await openNoteByTitle(receiverPage, title)
  await expectNoteBody(receiverPage, expectedBody)
}

async function runOfflineReceiverEditCase({
  pageA,
  pageB,
  creatorPage,
  editorPage,
  receiverPage,
  editorApp,
  receiverApp,
  offlineApp,
  title,
  initialBody,
  editText
}: {
  pageA: Page
  pageB: Page
  creatorPage: Page
  editorPage: Page
  receiverPage: Page
  editorApp: ElectronApplication
  receiverApp: ElectronApplication
  offlineApp: ElectronApplication
  title: string
  initialBody: string
  editText: string
}): Promise<void> {
  const expectedBody = `${initialBody}\n\n${editText}`

  await seedSharedNote({ pageA, pageB, creatorPage, title, body: initialBody })

  await goOffline(offlineApp)
  await waitForSyncOffline(receiverPage)

  await appendBodyAndPersist({ page: editorPage, title, editText, expectedBody })
  await waitForCrdtQueueIdle(editorApp)

  await goOnline(offlineApp)
  await waitForSyncOnline(receiverPage)

  await syncBothAndWait(pageA, pageB)

  await expect.poll(() => getCrdtDocBodyByTitle(receiverPage, receiverApp, title)).toBe(expectedBody)
  await expect.poll(() => getNoteFileBodyByTitle(receiverPage, title)).toBe(expectedBody)
  await openNoteByTitle(receiverPage, title)
  await expectNoteBody(receiverPage, expectedBody)
}

test.describe('Body CRDT single-writer edit propagation', () => {
  test('E1: A offline edits an A-created shared note, then B receives the body change', async ({
    electronAppA,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `E1 Offline Own Edit ${Date.now()}`
    const initialBody = 'shared note from A'
    const editText = 'offline edit from A'

    await runOfflineEditorEditCase({
      pageA,
      pageB,
      creatorPage: pageA,
      editorPage: pageA,
      receiverPage: pageB,
      offlineApp: electronAppA,
      title,
      initialBody,
      editText
    })
  })

  test('E2: B offline edits a B-created shared note, then A receives the body change', async ({
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `E2 Offline Own Edit ${Date.now()}`
    const initialBody = 'shared note from B'
    const editText = 'offline edit from B'

    await runOfflineEditorEditCase({
      pageA,
      pageB,
      creatorPage: pageB,
      editorPage: pageB,
      receiverPage: pageA,
      offlineApp: electronAppB,
      title,
      initialBody,
      editText
    })
  })

  test('E3: A offline edits a B-created shared note, then B receives the body change', async ({
    electronAppA,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `E3 Offline Peer Edit ${Date.now()}`
    const initialBody = 'shared note from B'
    const editText = 'offline edit from A on B note'

    await runOfflineEditorEditCase({
      pageA,
      pageB,
      creatorPage: pageB,
      editorPage: pageA,
      receiverPage: pageB,
      offlineApp: electronAppA,
      title,
      initialBody,
      editText
    })
  })

  test('E4: B offline edits an A-created shared note, then A receives the body change', async ({
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `E4 Offline Peer Edit ${Date.now()}`
    const initialBody = 'shared note from A'
    const editText = 'offline edit from B on A note'

    await runOfflineEditorEditCase({
      pageA,
      pageB,
      creatorPage: pageA,
      editorPage: pageB,
      receiverPage: pageA,
      offlineApp: electronAppB,
      title,
      initialBody,
      editText
    })
  })

  test('E5: A online edits a shared note while B is offline, then B receives the body change', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `E5 Receiver Offline ${Date.now()}`
    const initialBody = 'shared note from A'
    const editText = 'online edit from A while B offline'

    await runOfflineReceiverEditCase({
      pageA,
      pageB,
      creatorPage: pageA,
      editorPage: pageA,
      receiverPage: pageB,
      editorApp: electronAppA,
      receiverApp: electronAppB,
      offlineApp: electronAppB,
      title,
      initialBody,
      editText
    })
  })

  test('E6: B online edits a shared note while A is offline, then A receives the body change', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `E6 Receiver Offline ${Date.now()}`
    const initialBody = 'shared note from B'
    const editText = 'online edit from B while A offline'

    await runOfflineReceiverEditCase({
      pageA,
      pageB,
      creatorPage: pageB,
      editorPage: pageB,
      receiverPage: pageA,
      editorApp: electronAppB,
      receiverApp: electronAppA,
      offlineApp: electronAppA,
      title,
      initialBody,
      editText
    })
  })
})
