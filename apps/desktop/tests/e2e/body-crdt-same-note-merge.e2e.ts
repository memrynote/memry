import { test, expect } from './fixtures/sync-auth-fixtures'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  createNoteWithBody,
  expectNoteBody,
  getCrdtDocBodyByTitle,
  getNoteFileBodyByTitle,
  getWritebackDebugByTitle,
  openNoteByTitle,
  readNoteBodyText
} from './utils/note-sync-helpers'
import { SELECTORS } from './utils/electron-helpers'
import {
  goOffline,
  goOnline,
  syncBothAndWait,
  waitForCrdtQueueIdle,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'

type CursorPosition = 'start' | 'end'

interface BlockEdit {
  blockIndex: number
  cursorPosition: CursorPosition
  text: string
}

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

async function applyBlockEdit(page: Page, title: string, edit: BlockEdit): Promise<void> {
  await openNoteByTitle(page, title)
  const editorRoot = page.locator(SELECTORS.noteEditor).first()
  await editorRoot.waitFor({ state: 'visible', timeout: 10000 })
  await editorRoot.click()

  await page.evaluate(({ blockIndex, cursorPosition }) => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const doc = editor.document as any[]
    const target = doc[blockIndex]
    if (!target?.id) {
      throw new Error(`Block ${blockIndex} is not available`)
    }

    editor.focus()
    editor.setTextCursorPosition(target.id, cursorPosition)
  }, edit)

  await page.keyboard.type(edit.text)
}

async function assertMergedNoteOnBothDevices(
  electronAppA: ElectronApplication,
  electronAppB: ElectronApplication,
  pageA: Page,
  pageB: Page,
  title: string,
  expectedBodies: string[]
): Promise<void> {
  await openNoteByTitle(pageA, title)
  await openNoteByTitle(pageB, title)

  let finalBody = ''
  await expect
    .poll(async () => {
      const body = await readNoteBodyText(pageA)
      if (!expectedBodies.includes(body)) {
        return false
      }
      finalBody = body
      return true
    })
    .toBe(true)

  await expect.poll(() => readNoteBodyText(pageA)).toBe(finalBody)
  await expect.poll(() => readNoteBodyText(pageB)).toBe(finalBody)
  await expect.poll(() => getCrdtDocBodyByTitle(pageA, electronAppA, title)).toBe(finalBody)
  await expect.poll(() => getCrdtDocBodyByTitle(pageB, electronAppB, title)).toBe(finalBody)
  await expect
    .poll(
      async () => (await getWritebackDebugByTitle(pageA, electronAppA, title))?.lastMarkdown ?? null
    )
    .toBe(finalBody)
  await expect
    .poll(
      async () => (await getWritebackDebugByTitle(pageB, electronAppB, title))?.lastMarkdown ?? null
    )
    .toBe(finalBody)
  await expect.poll(() => getNoteFileBodyByTitle(pageA, title)).toBe(finalBody)
  await expect.poll(() => getNoteFileBodyByTitle(pageB, title)).toBe(finalBody)
}

async function runSameNoteMergeCase({
  electronAppA,
  electronAppB,
  pageA,
  pageB,
  creatorPage,
  title,
  initialBody,
  editA,
  editB,
  expectedBodies,
  expectedLocalBodyA,
  expectedLocalBodyB,
  offlineBeforeEditA,
  offlineBeforeEditB
}: {
  electronAppA: ElectronApplication
  electronAppB: ElectronApplication
  pageA: Page
  pageB: Page
  creatorPage: Page
  title: string
  initialBody: string
  editA: BlockEdit
  editB: BlockEdit
  expectedBodies: string[]
  expectedLocalBodyA?: string
  expectedLocalBodyB?: string
  offlineBeforeEditA: boolean
  offlineBeforeEditB: boolean
}): Promise<void> {
  await seedSharedNote({ pageA, pageB, creatorPage, title, body: initialBody })

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

  await Promise.all([applyBlockEdit(pageA, title, editA), applyBlockEdit(pageB, title, editB)])

  if (expectedLocalBodyA) {
    await expect.poll(() => readNoteBodyText(pageA)).toBe(expectedLocalBodyA)
    await expect.poll(() => getNoteFileBodyByTitle(pageA, title)).toBe(expectedLocalBodyA)
  }

  if (expectedLocalBodyB) {
    await expect.poll(() => readNoteBodyText(pageB)).toBe(expectedLocalBodyB)
    await expect.poll(() => getNoteFileBodyByTitle(pageB, title)).toBe(expectedLocalBodyB)
  }

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
  await assertMergedNoteOnBothDevices(
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    title,
    expectedBodies
  )
}

test.describe('Body CRDT same-note merge propagation', () => {
  test('M1: A offline and B offline edit different blocks on the same note, then both devices preserve both edits', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M1 Same Note Different Blocks ${Date.now()}`
    const initialBody = 'shared top block\n\nshared bottom block'
    const expectedBody = 'shared top block from A\n\nshared bottom block from B'
    const expectedLocalBodyA = 'shared top block from A\n\nshared bottom block'
    const expectedLocalBodyB = 'shared top block\n\nshared bottom block from B'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'end', text: ' from A' },
      editB: { blockIndex: 2, cursorPosition: 'end', text: ' from B' },
      expectedBodies: [expectedBody],
      expectedLocalBodyA,
      expectedLocalBodyB,
      offlineBeforeEditA: true,
      offlineBeforeEditB: true
    })
  })

  test('M2: A offline and B offline edit the same block at different insertion points, then both devices preserve the merge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M2 Same Block Different Positions ${Date.now()}`
    const initialBody = 'shared merge block'
    const expectedBody = 'A shared merge block B'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: [expectedBody],
      offlineBeforeEditA: true,
      offlineBeforeEditB: true
    })
  })

  test('M3: A offline and B offline insert at the same cursor position, then both devices converge on one deterministic merged body', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M3 Same Position Insert ${Date.now()}`
    const initialBody = 'shared merge block'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'start', text: 'B ' },
      expectedBodies: ['A B shared merge block', 'B A shared merge block'],
      offlineBeforeEditA: true,
      offlineBeforeEditB: true
    })
  })

  test('M4: A online and B offline edit the same note concurrently, then both devices preserve the merge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M4 A Online B Offline ${Date.now()}`
    const initialBody = 'shared live merge block'
    const expectedBody = 'A shared live merge block B'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: [expectedBody],
      offlineBeforeEditA: false,
      offlineBeforeEditB: true
    })
  })

  test('M5: A offline and B online edit the same note concurrently, then both devices preserve the merge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M5 A Offline B Online ${Date.now()}`
    const initialBody = 'shared live merge block'
    const expectedBody = 'A shared live merge block B'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: [expectedBody],
      offlineBeforeEditA: true,
      offlineBeforeEditB: false
    })
  })

  test('M6: A online and B online edit the same note concurrently, then both devices preserve the merge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M6 Both Online ${Date.now()}`
    const initialBody = 'shared live merge block'
    const expectedBody = 'A shared live merge block B'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: [expectedBody],
      offlineBeforeEditA: false,
      offlineBeforeEditB: false
    })
  })

  test('M7: A edits noteB while B also edits noteB, then both devices preserve the merge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M7 NoteB Cross Edit ${Date.now()}`
    const initialBody = 'noteB shared merge block'
    const expectedBody = 'A noteB shared merge block B'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageB,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: [expectedBody],
      offlineBeforeEditA: true,
      offlineBeforeEditB: true
    })
  })

  test('M8: B edits noteA while A also edits noteA, then both devices preserve the merge', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const title = `M8 NoteA Cross Edit ${Date.now()}`
    const initialBody = 'noteA shared merge block'
    const expectedBody = 'B noteA shared merge block A'

    await runSameNoteMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title,
      initialBody,
      editA: { blockIndex: 0, cursorPosition: 'end', text: ' A' },
      editB: { blockIndex: 0, cursorPosition: 'start', text: 'B ' },
      expectedBodies: [expectedBody],
      offlineBeforeEditA: true,
      offlineBeforeEditB: true
    })
  })
})
