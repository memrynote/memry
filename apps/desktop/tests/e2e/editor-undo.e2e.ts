import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  navigateTo,
  SELECTORS,
  SHORTCUTS,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'
import {
  getNoteFileBodyById,
  normalizeBodyText,
  openNoteByHandle,
  readNoteBodyText,
  type NoteHandle
} from './utils/note-sync-helpers'

test.describe('Editor undo history', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('note first-open undo preserves the seeded body', async ({ page }) => {
    const body = `Undo seed line ${Date.now()}\n\nSecond seeded line`
    const note = await seedNote(page, `Undo Note ${Date.now()}`, body)

    await openNoteByHandle(page, note)
    await expectNoteEditorBody(page, body)

    await page.keyboard.press(SHORTCUTS.undo)
    await expectNoteEditorBody(page, body)

    await page.waitForTimeout(1500)
    await expect.poll(() => getNoteFileBodyById(page, note.id)).toBe(normalizeBodyText(body))
  })

  test('note undo still works after a local edit', async ({ page }) => {
    const body = `Undo editable seed ${Date.now()}`
    const typedLine = 'typed after open'
    const note = await seedNote(page, `Undo Editable Note ${Date.now()}`, body)

    await openNoteByHandle(page, note)
    await expectNoteEditorBody(page, body)

    await focusEditorEnd(page)
    await page.keyboard.type(typedLine)
    await expectNoteEditorBody(page, `${body}\n\n${typedLine}`)

    await page.keyboard.press(SHORTCUTS.undo)
    await expectNoteEditorBody(page, body)
  })

  test('Edit menu Undo reverts a local edit', async ({ electronApp, page }) => {
    // Regression: Edit→Undo used role 'undo' (Chromium's native undo stack),
    // which is empty in the BlockNote editor — the menu item silently did
    // nothing on every platform, and its registered accelerator swallowed
    // Ctrl+Z on Windows/Linux. Drives the real menu item, not the keyboard.
    const body = `Menu undo seed ${Date.now()}`
    const typedLine = 'typed before menu undo'
    const note = await seedNote(page, `Menu Undo Note ${Date.now()}`, body)

    await openNoteByHandle(page, note)
    await expectNoteEditorBody(page, body)

    await focusEditorEnd(page)
    await page.keyboard.type(typedLine)
    await expectNoteEditorBody(page, `${body}\n\n${typedLine}`)

    await clickApplicationMenuItem(electronApp, 'Undo')
    await expectNoteEditorBody(page, body)
  })

  test('journal first-open undo preserves the seeded entry', async ({ page }) => {
    const body = `Journal undo seed ${Date.now()}\n\nStill here after undo`
    await seedCurrentJournalEntry(page, body)

    await navigateTo(page, 'journal')
    await expectNoteEditorBody(page, body)

    await page.keyboard.press(SHORTCUTS.undo)
    await expectNoteEditorBody(page, body)

    await page.waitForTimeout(1500)
    await expect.poll(() => currentJournalEntryContent(page)).toBe(body)
  })
})

async function clickApplicationMenuItem(
  electronApp: ElectronApplication,
  label: string
): Promise<void> {
  await electronApp.evaluate(({ Menu, BrowserWindow }, itemLabel) => {
    // The renderer dispatch targets the focused window; make sure there is one.
    BrowserWindow.getAllWindows()[0]?.focus()
    const menu = Menu.getApplicationMenu()
    if (!menu) throw new Error('No application menu')
    const flatten = (items: Electron.MenuItem[]): Electron.MenuItem[] =>
      items.flatMap((item) => [item, ...(item.submenu ? flatten(item.submenu.items) : [])])
    const item = flatten(menu.items).find((candidate) => candidate.label === itemLabel)
    if (!item) throw new Error(`Application menu item "${itemLabel}" not found`)
    item.click()
  }, label)
}

async function seedNote(page: Page, title: string, content: string): Promise<NoteHandle> {
  return page.evaluate(
    async ({ noteTitle, noteContent }) => {
      const result = await window.api.notes.create({ title: noteTitle, content: noteContent })
      if (!result.success || !result.note) {
        throw new Error(result.error || `Failed to create note "${noteTitle}"`)
      }
      return {
        id: result.note.id,
        title: result.note.title,
        emoji: result.note.emoji ?? null
      }
    },
    { noteTitle: title, noteContent: content }
  )
}

async function seedCurrentJournalEntry(page: Page, content: string): Promise<void> {
  const date = await currentLocalDate(page)
  await page.evaluate(
    async ({ journalDate, journalContent }) => {
      await window.api.journal.updateEntry({ date: journalDate, content: journalContent })
    },
    { journalDate: date, journalContent: content }
  )
}

async function currentJournalEntryContent(page: Page): Promise<string | null> {
  const date = await currentLocalDate(page)
  return page.evaluate(async (journalDate) => {
    const entry = await window.api.journal.getEntry(journalDate)
    return entry?.content ?? null
  }, date)
}

async function currentLocalDate(page: Page): Promise<string> {
  return page.evaluate(() => {
    const now = new Date()
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
  })
}

async function expectNoteEditorBody(page: Page, expectedBody: string): Promise<void> {
  await expect.poll(() => readNoteBodyText(page)).toBe(normalizeBodyText(expectedBody))
}

async function focusEditorEnd(page: Page): Promise<void> {
  const editorRoot = page.locator(SELECTORS.noteEditor).first()
  await editorRoot.waitFor({ state: 'visible', timeout: 10000 })
  await page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const lastBlock = (editor.document as any[]).at(-1)
    editor.focus()
    if (lastBlock?.id) {
      editor.setTextCursorPosition(lastBlock.id, 'end')
    }
  })
}
