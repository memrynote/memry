import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'
import { getNoteFileBodyById, openNoteByHandle, type NoteHandle } from './utils/note-sync-helpers'

const SEED_BODY = 'Centred line\n\n## Right heading'

const MARKED_LINES = [
  '<!-- align:center -->\nCentred line',
  '<!-- align:right -->\n## Right heading'
]

interface BlockAlignment {
  type: string
  text: string
  alignment: string
}

interface DocumentAlignment {
  first: BlockAlignment | null
  heading: BlockAlignment | null
}

const UNALIGNED: DocumentAlignment = {
  first: { type: 'paragraph', text: 'Centred line', alignment: 'left' },
  heading: { type: 'heading', text: 'Right heading', alignment: 'left' }
}

const ALIGNED: DocumentAlignment = {
  first: { type: 'paragraph', text: 'Centred line', alignment: 'center' },
  heading: { type: 'heading', text: 'Right heading', alignment: 'right' }
}

const PERSIST_TIMEOUT_MS = 30_000

async function createNote(page: Page, title: string, content: string): Promise<NoteHandle> {
  return page.evaluate(
    async ({ noteTitle, noteContent }) => {
      const result = await window.api.notes.create({ title: noteTitle, content: noteContent })
      if (!result.success || !result.note) {
        throw new Error(result.error || `Failed to create note "${noteTitle}"`)
      }
      return { id: result.note.id, title: result.note.title, emoji: result.note.emoji ?? null }
    },
    { noteTitle: title, noteContent: content }
  )
}

async function readAlignments(page: Page): Promise<DocumentAlignment> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) return { first: null, heading: null }

    const describe = (block: any) =>
      block
        ? {
            type: block.type as string,
            text: ((block.content ?? []) as any[]).map((part) => part.text ?? '').join(''),
            alignment: block.props?.textAlignment as string
          }
        : null

    const doc = editor.document as any[]
    return {
      first: describe(doc[0]),
      heading: describe(doc.find((block) => block.type === 'heading'))
    }
  })
}

test.describe('Text alignment persistence', () => {
  test('alignment survives leaving the note and restarting the app', async ({
    page,
    testVaultPath
  }) => {
    test.setTimeout(120_000)
    await ready(page)

    const aligned = await createNote(page, uniqueLabel('Aligned Note'), SEED_BODY)
    const neighbour = await createNote(page, uniqueLabel('Neighbour Note'), 'Somewhere else')

    await openNoteByHandle(page, aligned)
    await expect
      .poll(() => readAlignments(page), { timeout: PERSIST_TIMEOUT_MS })
      .toEqual(UNALIGNED)

    await page.evaluate(() => {
      const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
      if (!editor) throw new Error('window.__memryEditor not exposed')

      const doc = editor.document as any[]
      const heading = doc.find((block) => block.type === 'heading')
      if (!doc[0] || !heading) {
        throw new Error('seed body did not parse into a paragraph followed by a heading')
      }

      editor.updateBlock(doc[0], { props: { textAlignment: 'center' } })
      editor.updateBlock(heading, { props: { textAlignment: 'right' } })
    })

    for (const snippet of MARKED_LINES) {
      await expect
        .poll(() => getNoteFileBodyById(page, aligned.id), { timeout: PERSIST_TIMEOUT_MS })
        .toContain(snippet)
    }

    await openNoteByHandle(page, neighbour)
    await openNoteByHandle(page, aligned)
    await expect.poll(() => readAlignments(page), { timeout: PERSIST_TIMEOUT_MS }).toEqual(ALIGNED)

    const relaunched = await launchElectronWithWindow({ testVaultPath })
    try {
      const restarted = relaunched.page
      await ready(restarted)
      await openNoteByHandle(restarted, aligned)

      await expect
        .poll(() => readAlignments(restarted), { timeout: PERSIST_TIMEOUT_MS })
        .toEqual(ALIGNED)
      await expect(
        restarted.locator('.bn-block-content[data-text-alignment="center"]')
      ).toBeVisible({ timeout: PERSIST_TIMEOUT_MS })
    } finally {
      const dirs = [relaunched.userDataDir]
      if (relaunched.resolvedUserDataDir !== relaunched.userDataDir) {
        dirs.push(relaunched.resolvedUserDataDir)
      }
      await destroyElectronApp(relaunched.app, dirs)
    }
  })
})
