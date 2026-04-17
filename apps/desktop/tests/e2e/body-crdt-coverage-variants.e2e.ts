import { test, expect } from './fixtures/sync-auth-fixtures'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  appendToNoteBody,
  createNoteWithBody,
  expectNoteBody,
  getCrdtDocBodyByTitle,
  getNoteFileBodyByTitle,
  getNoteHandleByTitle,
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
type ReconnectOrder = 'a-first' | 'b-first' | 'together'
type ReceiverState = 'open' | 'closed'

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

async function closeTabByTitle(page: Page, title: string): Promise<void> {
  const tab = page.locator(`${SELECTORS.tab}:has-text("${title}")`).first()
  await expect(tab).toBeVisible()

  await tab.hover()
  const closeButton = tab.locator('button[aria-label^="Close"]').first()
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click()
  } else {
    await tab.click({ button: 'middle' })
  }

  await expect(tab).toBeHidden()
}

async function reconnectDevices({
  electronAppA,
  electronAppB,
  pageA,
  pageB,
  order
}: {
  electronAppA: ElectronApplication
  electronAppB: ElectronApplication
  pageA: Page
  pageB: Page
  order: ReconnectOrder
}): Promise<void> {
  if (order === 'a-first') {
    await goOnline(electronAppA)
    await waitForSyncOnline(pageA)
    await goOnline(electronAppB)
    await waitForSyncOnline(pageB)
  } else if (order === 'b-first') {
    await goOnline(electronAppB)
    await waitForSyncOnline(pageB)
    await goOnline(electronAppA)
    await waitForSyncOnline(pageA)
  } else {
    await Promise.all([goOnline(electronAppA), goOnline(electronAppB)])
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
  }

  await syncBothAndWait(pageA, pageB)
}

async function assertMergedNoteOnBothDevices(
  electronAppA: ElectronApplication,
  electronAppB: ElectronApplication,
  pageA: Page,
  pageB: Page,
  title: string,
  expectedBodies: string[]
): Promise<void> {
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

async function runOfflineOfflineMergeCase({
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
  reconnectOrder,
  closedBeforeReconnect
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
  reconnectOrder: ReconnectOrder
  closedBeforeReconnect?: 'a' | 'b'
}): Promise<void> {
  await seedSharedNote({ pageA, pageB, creatorPage, title, body: initialBody })

  await Promise.all([goOffline(electronAppA), goOffline(electronAppB)])
  await Promise.all([waitForSyncOffline(pageA), waitForSyncOffline(pageB)])

  await Promise.all([applyBlockEdit(pageA, title, editA), applyBlockEdit(pageB, title, editB)])

  if (closedBeforeReconnect === 'a') {
    await closeTabByTitle(pageA, title)
  }
  if (closedBeforeReconnect === 'b') {
    await closeTabByTitle(pageB, title)
  }

  await reconnectDevices({ electronAppA, electronAppB, pageA, pageB, order: reconnectOrder })

  if (closedBeforeReconnect === 'a') {
    await openNoteByTitle(pageA, title)
  }
  if (closedBeforeReconnect === 'b') {
    await openNoteByTitle(pageB, title)
  }

  await assertMergedNoteOnBothDevices(
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    title,
    expectedBodies
  )
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

async function runReceiverStateSingleWriterCase({
  electronAppA,
  electronAppB,
  pageA,
  pageB,
  creatorPage,
  editorPage,
  receiverPage,
  editorApp,
  receiverApp,
  title,
  initialBody,
  editText,
  receiverState
}: {
  electronAppA: ElectronApplication
  electronAppB: ElectronApplication
  pageA: Page
  pageB: Page
  creatorPage: Page
  editorPage: Page
  receiverPage: Page
  editorApp: ElectronApplication
  receiverApp: ElectronApplication
  title: string
  initialBody: string
  editText: string
  receiverState: ReceiverState
}): Promise<void> {
  const expectedBody = `${initialBody}\n\n${editText}`

  await seedSharedNote({ pageA, pageB, creatorPage, title, body: initialBody })

  if (receiverState === 'closed') {
    await closeTabByTitle(receiverPage, title)
  }

  await goOffline(receiverApp)
  await waitForSyncOffline(receiverPage)

  await appendBodyAndPersist({ page: editorPage, title, editText, expectedBody })
  await waitForCrdtQueueIdle(editorApp)

  await goOnline(receiverApp)
  await waitForSyncOnline(receiverPage)
  await syncBothAndWait(pageA, pageB)

  await expect
    .poll(() => getCrdtDocBodyByTitle(receiverPage, receiverApp, title))
    .toBe(expectedBody)
  await expect.poll(() => getNoteFileBodyByTitle(receiverPage, title)).toBe(expectedBody)

  if (receiverState === 'closed') {
    await openNoteByTitle(receiverPage, title)
  }

  await expectNoteBody(receiverPage, expectedBody)
  await assertMergedNoteOnBothDevices(electronAppA, electronAppB, pageA, pageB, title, [
    expectedBody
  ])
}

async function expectSharedNoteTitles(page: Page, titles: string[]): Promise<void> {
  const expectedTitles = [...titles].sort((a, b) => a.localeCompare(b))

  await expect
    .poll(
      async () => {
        const result = await page.evaluate(async () => {
          return window.api.notes.list({
            limit: 10_000,
            sortBy: 'title',
            sortOrder: 'asc'
          })
        })

        return result.notes
          .map((note) => note.title)
          .filter((title) => expectedTitles.includes(title))
          .sort((a, b) => a.localeCompare(b))
      },
      { timeout: 60_000 }
    )
    .toEqual(expectedTitles)
}

test.describe('Body CRDT coverage variants', () => {
  const offlineOfflineScenarios = [
    {
      name: 'different blocks',
      initialBody: 'shared top block\n\nshared bottom block',
      editA: { blockIndex: 0, cursorPosition: 'end', text: ' from A' } satisfies BlockEdit,
      editB: { blockIndex: 2, cursorPosition: 'end', text: ' from B' } satisfies BlockEdit,
      expectedBodies: ['shared top block from A\n\nshared bottom block from B'],
      creator: 'A' as const
    },
    {
      name: 'same block different insertion points',
      initialBody: 'shared merge block',
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' } satisfies BlockEdit,
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' } satisfies BlockEdit,
      expectedBodies: ['A shared merge block B'],
      creator: 'A' as const
    },
    {
      name: 'same exact cursor position',
      initialBody: 'shared merge block',
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' } satisfies BlockEdit,
      editB: { blockIndex: 0, cursorPosition: 'start', text: 'B ' } satisfies BlockEdit,
      expectedBodies: ['A B shared merge block', 'B A shared merge block'],
      creator: 'A' as const
    }
  ]

  for (const reconnectOrder of ['a-first', 'b-first', 'together'] as const) {
    for (const scenario of offlineOfflineScenarios) {
      test(`V${reconnectOrder === 'a-first' ? '1' : reconnectOrder === 'b-first' ? '2' : '3'}: ${scenario.name} converges when reconnect order is ${reconnectOrder}`, async ({
        electronAppA,
        electronAppB,
        pageA,
        pageB,
        bootstrappedSyncPair
      }) => {
        void bootstrappedSyncPair

        const title = `V${reconnectOrder}-${scenario.name}-${Date.now()}`

        await runOfflineOfflineMergeCase({
          electronAppA,
          electronAppB,
          pageA,
          pageB,
          creatorPage: scenario.creator === 'A' ? pageA : pageB,
          title,
          initialBody: scenario.initialBody,
          editA: scenario.editA,
          editB: scenario.editB,
          expectedBodies: scenario.expectedBodies,
          reconnectOrder
        })
      })
    }
  }

  test('V4: receiver-open variants converge for representative single-writer and merge cases', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const singleWriterTitle = `V4 Receiver Open Single Writer ${Date.now()}`
    await runReceiverStateSingleWriterCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      editorPage: pageA,
      receiverPage: pageB,
      editorApp: electronAppA,
      receiverApp: electronAppB,
      title: singleWriterTitle,
      initialBody: 'shared note from A',
      editText: 'online edit from A while B offline',
      receiverState: 'open'
    })

    const mergeTitle = `V4 Receiver Open Merge ${Date.now()}`
    await runOfflineOfflineMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title: mergeTitle,
      initialBody: 'shared receiver-open merge block',
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: ['A shared receiver-open merge block B'],
      reconnectOrder: 'together'
    })
  })

  test('V5: receiver-closed variants converge after the note is reopened', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const singleWriterTitle = `V5 Receiver Closed Single Writer ${Date.now()}`
    await runReceiverStateSingleWriterCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      editorPage: pageA,
      receiverPage: pageB,
      editorApp: electronAppA,
      receiverApp: electronAppB,
      title: singleWriterTitle,
      initialBody: 'shared note from A',
      editText: 'online edit from A while B offline',
      receiverState: 'closed'
    })

    const mergeTitle = `V5 Receiver Closed Merge ${Date.now()}`
    await runOfflineOfflineMergeCase({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      creatorPage: pageA,
      title: mergeTitle,
      initialBody: 'shared receiver-closed merge block',
      editA: { blockIndex: 0, cursorPosition: 'start', text: 'A ' },
      editB: { blockIndex: 0, cursorPosition: 'end', text: ' B' },
      expectedBodies: ['A shared receiver-closed merge block B'],
      reconnectOrder: 'together',
      closedBeforeReconnect: 'b'
    })
  })

  test('V6: both devices create one note offline, sync, then preserve 4 cross-edits across 2 notes', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const prefix = `V6 Two Notes Four Edits ${Date.now()}`
    const titleA = `${prefix} NoteA`
    const titleB = `${prefix} NoteB`

    await Promise.all([goOffline(electronAppA), goOffline(electronAppB)])
    await Promise.all([waitForSyncOffline(pageA), waitForSyncOffline(pageB)])

    await createNoteWithBody(pageA, titleA, 'noteA shared merge block')
    await createNoteWithBody(pageB, titleB, 'noteB shared merge block')

    await reconnectDevices({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      order: 'together'
    })

    await expectSharedNoteTitles(pageA, [titleA, titleB])
    await expectSharedNoteTitles(pageB, [titleA, titleB])

    await Promise.all([
      applyBlockEdit(pageA, titleB, { blockIndex: 0, cursorPosition: 'start', text: 'A ' }),
      applyBlockEdit(pageB, titleB, { blockIndex: 0, cursorPosition: 'end', text: ' B' })
    ])
    await Promise.all([waitForCrdtQueueIdle(electronAppA), waitForCrdtQueueIdle(electronAppB)])
    await syncBothAndWait(pageA, pageB)
    await assertMergedNoteOnBothDevices(electronAppA, electronAppB, pageA, pageB, titleB, [
      'A noteB shared merge block B'
    ])

    await Promise.all([
      applyBlockEdit(pageA, titleA, { blockIndex: 0, cursorPosition: 'end', text: ' A' }),
      applyBlockEdit(pageB, titleA, { blockIndex: 0, cursorPosition: 'start', text: 'B ' })
    ])
    await Promise.all([waitForCrdtQueueIdle(electronAppA), waitForCrdtQueueIdle(electronAppB)])
    await syncBothAndWait(pageA, pageB)
    await assertMergedNoteOnBothDevices(electronAppA, electronAppB, pageA, pageB, titleA, [
      'B noteA shared merge block A'
    ])

    await expectSharedNoteTitles(pageA, [titleA, titleB])
    await expectSharedNoteTitles(pageB, [titleA, titleB])
  })
})
