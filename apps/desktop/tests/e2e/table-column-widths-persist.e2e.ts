import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'
import { getNoteFileBodyById, openNoteByHandle, type NoteHandle } from './utils/note-sync-helpers'

const SEED_BODY = ['| Task | State |', '| --- | --- |', '| Shipping | Open |'].join('\n')

const DRAGGED_WIDTH = 220
const MARKER = `<!-- table-layout:{"columnWidths":[${DRAGGED_WIDTH},null]} -->`

const PERSIST_TIMEOUT_MS = 30_000
/** The rendered column is the width the prop asks for, give or take rounding. */
const WIDTH_TOLERANCE_PX = 2

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

async function readColumnWidths(page: Page): Promise<unknown[] | null> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) return null
    const table = (editor.document as any[]).find((block) => block.type === 'table')
    return table ? ((table.content?.columnWidths ?? null) as unknown[] | null) : null
  })
}

async function dragFirstColumnTo(page: Page, width: number): Promise<void> {
  await page.evaluate((next) => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const table = (editor.document as any[]).find((block) => block.type === 'table')
    if (!table) throw new Error('seed body did not parse into a table')

    const widths = [...((table.content.columnWidths ?? []) as unknown[])]
    widths[0] = next
    editor.updateBlock(table, { content: { ...table.content, columnWidths: widths } })
  }, width)
}

test.describe('Table column width persistence', () => {
  test('a dragged column width survives leaving the note and restarting the app', async ({
    page,
    testVaultPath
  }) => {
    test.setTimeout(120_000)
    await ready(page)

    const resized = await createNote(page, uniqueLabel('Resized Table Note'), SEED_BODY)
    const neighbour = await createNote(page, uniqueLabel('Neighbour Note'), 'Somewhere else')

    await openNoteByHandle(page, resized)
    await expect.poll(() => readColumnWidths(page), { timeout: PERSIST_TIMEOUT_MS }).toHaveLength(2)

    await dragFirstColumnTo(page, DRAGGED_WIDTH)

    await expect
      .poll(() => getNoteFileBodyById(page, resized.id), { timeout: PERSIST_TIMEOUT_MS })
      .toContain(MARKER)

    await openNoteByHandle(page, neighbour)
    await openNoteByHandle(page, resized)
    await expect
      .poll(async () => (await readColumnWidths(page))?.[0], { timeout: PERSIST_TIMEOUT_MS })
      .toBe(DRAGGED_WIDTH)

    const relaunched = await launchElectronWithWindow({ testVaultPath })
    try {
      const restarted = relaunched.page
      await ready(restarted)
      await openNoteByHandle(restarted, resized)

      await expect
        .poll(async () => (await readColumnWidths(restarted))?.[0], {
          timeout: PERSIST_TIMEOUT_MS
        })
        .toBe(DRAGGED_WIDTH)

      const firstColumn = restarted.locator('.bn-block-content table col').first()
      await expect(firstColumn).toHaveAttribute('style', `width: ${DRAGGED_WIDTH}px;`, {
        timeout: PERSIST_TIMEOUT_MS
      })

      // `<col>` is not itself a painted box, so the width that reaches the user
      // is the one the first header cell ends up with.
      const firstCell = restarted.locator('.bn-block-content table tr').first().locator('td, th')
      await expect
        .poll(
          async () => {
            const measured = (await firstCell.first().boundingBox())?.width ?? 0
            return Math.abs(measured - DRAGGED_WIDTH) <= WIDTH_TOLERANCE_PX
          },
          { timeout: PERSIST_TIMEOUT_MS }
        )
        .toBe(true)
    } finally {
      const dirs = [relaunched.userDataDir]
      if (relaunched.resolvedUserDataDir !== relaunched.userDataDir) {
        dirs.push(relaunched.resolvedUserDataDir)
      }
      await destroyElectronApp(relaunched.app, dirs)
    }
  })
})
