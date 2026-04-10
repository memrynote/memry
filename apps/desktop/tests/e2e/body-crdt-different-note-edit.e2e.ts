import { test, expect } from './fixtures/sync-auth-fixtures'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  appendToNoteBody,
  createNoteWithBody,
  expectNoteBody,
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

async function seedSharedNotes({
  pageA,
  pageB,
  titleA,
  titleB,
  bodyA,
  bodyB
}: {
  pageA: Page
  pageB: Page
  titleA: string
  titleB: string
  bodyA: string
  bodyB: string
}): Promise<void> {
  await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])

  await createNoteWithBody(pageA, titleA, bodyA)
  await syncBothAndWait(pageA, pageB)

  await createNoteWithBody(pageB, titleB, bodyB)
  await syncBothAndWait(pageA, pageB)

  await assertNoteOnBothDevices(pageA, pageB, titleA, bodyA)
  await assertNoteOnBothDevices(pageA, pageB, titleB, bodyB)
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

async function assertNoteOnBothDevices(
  pageA: Page,
  pageB: Page,
  title: string,
  expectedBody: string
): Promise<void> {
  await expect.poll(() => getNoteFileBodyByTitle(pageA, title)).toBe(expectedBody)
  await expect.poll(() => getNoteFileBodyByTitle(pageB, title)).toBe(expectedBody)

  await openNoteByTitle(pageA, title)
  await expectNoteBody(pageA, expectedBody)

  await openNoteByTitle(pageB, title)
  await expectNoteBody(pageB, expectedBody)
}

async function runDifferentNoteEditCase({
  electronAppA,
  electronAppB,
  pageA,
  pageB,
  titleA,
  titleB,
  initialBodyA,
  initialBodyB,
  editTextA,
  editTextB,
  offlineBeforeEditA,
  offlineBeforeEditB
}: {
  electronAppA: ElectronApplication
  electronAppB: ElectronApplication
  pageA: Page
  pageB: Page
  titleA: string
  titleB: string
  initialBodyA: string
  initialBodyB: string
  editTextA: string
  editTextB: string
  offlineBeforeEditA: boolean
  offlineBeforeEditB: boolean
}): Promise<void> {
  const expectedBodyA = `${initialBodyA}\n\n${editTextA}`
  const expectedBodyB = `${initialBodyB}\n\n${editTextB}`

  await seedSharedNotes({
    pageA,
    pageB,
    titleA,
    titleB,
    bodyA: initialBodyA,
    bodyB: initialBodyB
  })

  if (offlineBeforeEditA) {
    await goOffline(electronAppA)
    await waitForSyncOffline(pageA)
  } else {
    await waitForSyncOnline(pageA)
  }

  if (offlineBeforeEditB) {
    await goOffline(electronAppB)
    await waitForSyncOffline(pageB)
  } else {
    await waitForSyncOnline(pageB)
  }

  await Promise.all([
    appendBodyAndPersist({
      page: pageA,
      title: titleA,
      editText: editTextA,
      expectedBody: expectedBodyA
    }),
    appendBodyAndPersist({
      page: pageB,
      title: titleB,
      editText: editTextB,
      expectedBody: expectedBodyB
    })
  ])

  const liveEditors: Promise<number>[] = []
  if (!offlineBeforeEditA) {
    liveEditors.push(waitForCrdtQueueIdle(electronAppA))
  }
  if (!offlineBeforeEditB) {
    liveEditors.push(waitForCrdtQueueIdle(electronAppB))
  }
  await Promise.all(liveEditors)

  if (offlineBeforeEditA) {
    await goOnline(electronAppA)
    await waitForSyncOnline(pageA)
  }

  if (offlineBeforeEditB) {
    await goOnline(electronAppB)
    await waitForSyncOnline(pageB)
  }

  await syncBothAndWait(pageA, pageB)

  await assertNoteOnBothDevices(pageA, pageB, titleA, expectedBodyA)
  await assertNoteOnBothDevices(pageA, pageB, titleB, expectedBodyB)
}

test.describe('Body CRDT different-note edit propagation', () => {
  test('D1: A offline edits noteA while B offline edits noteB, then both devices converge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    await runDifferentNoteEditCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      titleA: `D1 Note A ${Date.now()}`,
      titleB: `D1 Note B ${Date.now()}`,
      initialBodyA: 'shared noteA body',
      initialBodyB: 'shared noteB body',
      editTextA: 'offline edit from A on noteA',
      editTextB: 'offline edit from B on noteB',
      offlineBeforeEditA: true,
      offlineBeforeEditB: true
    })
  })

  test('D2: A online edits noteA while B offline edits noteB, then both devices converge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    await runDifferentNoteEditCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      titleA: `D2 Note A ${Date.now()}`,
      titleB: `D2 Note B ${Date.now()}`,
      initialBodyA: 'shared noteA body',
      initialBodyB: 'shared noteB body',
      editTextA: 'online edit from A on noteA',
      editTextB: 'offline edit from B on noteB',
      offlineBeforeEditA: false,
      offlineBeforeEditB: true
    })
  })

  test('D3: A offline edits noteA while B online edits noteB, then both devices converge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    await runDifferentNoteEditCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      titleA: `D3 Note A ${Date.now()}`,
      titleB: `D3 Note B ${Date.now()}`,
      initialBodyA: 'shared noteA body',
      initialBodyB: 'shared noteB body',
      editTextA: 'offline edit from A on noteA',
      editTextB: 'online edit from B on noteB',
      offlineBeforeEditA: true,
      offlineBeforeEditB: false
    })
  })

  test('D4: A online and B online edit different notes concurrently, then both devices converge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    await runDifferentNoteEditCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      titleA: `D4 Note A ${Date.now()}`,
      titleB: `D4 Note B ${Date.now()}`,
      initialBodyA: 'shared noteA body',
      initialBodyB: 'shared noteB body',
      editTextA: 'online edit from A on noteA',
      editTextB: 'online edit from B on noteB',
      offlineBeforeEditA: false,
      offlineBeforeEditB: false
    })
  })
})
