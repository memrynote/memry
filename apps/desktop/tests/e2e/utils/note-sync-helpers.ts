import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { SELECTORS } from './electron-helpers'

interface MemryNoteTestHooks {
  getCrdtDocMarkdown(noteId: string): Promise<string | null>
  getWritebackDebugState(noteId: string): Promise<{
    pending: boolean
    scheduledCount: number
    performedCount: number
    lastMarkdown: string | null
    lastError: string | null
  } | null>
}

function normalizeBodyText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function bodyToParagraphBlocks(body: string) {
  return body.split('\n').map((line) => ({
    type: 'paragraph',
    content: line.length
      ? [
          {
            type: 'text',
            text: line,
            styles: {}
          }
        ]
      : []
  }))
}

async function openNoteInUi(
  page: Page,
  note: { id: string; title: string; emoji?: string | null }
): Promise<void> {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail }))
  }, note)

  await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(note.title)
}

async function waitForPersistedNoteBody(page: Page, noteId: string, body: string): Promise<void> {
  const requiredSnippets = body.split('\n').filter((line) => line.length > 0)
  await expect
    .poll(async () => {
      const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
      const content = note?.content ?? ''
      return requiredSnippets.every((snippet) => content.includes(snippet))
    })
    .toBe(true)
}

async function waitForNoteEditor(page: Page) {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  return editor
}

export async function createNoteWithBody(page: Page, title: string, body: string): Promise<void> {
  const note = await page.evaluate(async (inputTitle) => {
    const result = await window.api.notes.create({ title: inputTitle, content: '' })
    if (!result.success || !result.note) {
      throw new Error(result.error || `Failed to create note "${inputTitle}"`)
    }
    return {
      id: result.note.id,
      title: result.note.title,
      emoji: result.note.emoji ?? null
    }
  }, title)

  await openNoteInUi(page, note)
  await replaceNoteBody(page, body)
  await waitForPersistedNoteBody(page, note.id, body)
}

export async function openNoteByTitle(page: Page, title: string): Promise<void> {
  const tab = page.locator(SELECTORS.tab).filter({ hasText: title }).first()
  if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) {
    await tab.click()
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(title)
    return
  }

  const note = await getNoteHandleByTitle(page, title)
  await openNoteInUi(page, note)
}

// Sync-dependent polls need more headroom than the default 10 s expect timeout
// because they depend on cross-device replication landing in B's index.
// Querying by exact title also avoids the default notes:list pagination path,
// which can miss the target note even after it exists.
const NOTE_LIST_POLL_TIMEOUT_MS = 60_000

export async function getNoteHandleByTitle(
  page: Page,
  title: string
): Promise<{ id: string; title: string; emoji?: string | null }> {
  let note: { id: string; title: string; emoji?: string | null } | null = null
  await expect
    .poll(
      async () => {
        note = await page.evaluate(async (expectedTitle) => {
          const match = await window.api.notes.resolveByTitle(expectedTitle)
          return match?.fileType === 'markdown'
            ? { id: match.id, title: match.title, emoji: null }
            : null
        }, title)
        return note !== null
      },
      { timeout: NOTE_LIST_POLL_TIMEOUT_MS }
    )
    .toBe(true)

  return note!
}

export async function getNoteFileBodyByTitle(page: Page, title: string): Promise<string | null> {
  const note = await getNoteHandleByTitle(page, title)
  const body = await page.evaluate(async (id) => {
    const loaded = await window.api.notes.get(id)
    return loaded?.content ?? null
  }, note.id)
  return body === null ? null : normalizeBodyText(body)
}

export async function getCrdtDocBodyByTitle(
  page: Page,
  electronApp: ElectronApplication,
  title: string
): Promise<string | null> {
  const note = await getNoteHandleByTitle(page, title)
  const body = await electronApp.evaluate(async (_context, noteId) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: MemryNoteTestHooks
      }
    ).__memryTestHooks

    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }

    return hooks.getCrdtDocMarkdown(noteId)
  }, note.id)

  return body === null ? null : normalizeBodyText(body)
}

export async function getWritebackDebugByTitle(
  page: Page,
  electronApp: ElectronApplication,
  title: string
): Promise<{
  pending: boolean
  scheduledCount: number
  performedCount: number
  lastMarkdown: string | null
  lastError: string | null
} | null> {
  const note = await getNoteHandleByTitle(page, title)
  const state = await electronApp.evaluate(async (_context, noteId) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: MemryNoteTestHooks
      }
    ).__memryTestHooks

    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }

    return hooks.getWritebackDebugState(noteId)
  }, note.id)

  if (!state) return null

  return {
    ...state,
    lastMarkdown: state.lastMarkdown === null ? null : normalizeBodyText(state.lastMarkdown)
  }
}

export async function replaceNoteBody(page: Page, body: string): Promise<void> {
  await waitForNoteEditor(page)
  const nextBlocks = bodyToParagraphBlocks(body)
  await page.evaluate((blocks) => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, blocks)
  }, nextBlocks)
}

export async function appendToNoteBody(page: Page, text: string): Promise<void> {
  const editorRoot = await waitForNoteEditor(page)
  const hasContent = await page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const doc = editor.document as any[]
    editor.focus()
    if (doc.length > 0) {
      const lastBlock = doc[doc.length - 1]
      if (lastBlock?.id) {
        editor.setTextCursorPosition(lastBlock.id, 'end')
      }
    }
    return doc.length > 0
  })

  await editorRoot.click()
  if (hasContent) {
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
  }
  await page.keyboard.type(text)
}

export async function readNoteBodyText(page: Page): Promise<string> {
  await waitForNoteEditor(page)
  const text = await page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const readInlineContent = (content: any[] | undefined): string => {
      if (!Array.isArray(content)) return ''
      return content
        .map((item) => {
          if (typeof item?.text === 'string') return item.text
          if (Array.isArray(item?.content)) return readInlineContent(item.content)
          return ''
        })
        .join('')
    }

    const readBlocks = (blocks: any[]): string[] => {
      const parts: string[] = []
      for (const block of blocks) {
        const ownText = readInlineContent(block?.content)
        const childText = Array.isArray(block?.children)
          ? readBlocks(block.children).join('\n\n')
          : ''
        const blockText = ownText && childText ? `${ownText}\n\n${childText}` : ownText || childText
        parts.push(blockText)
      }
      return parts
    }

    return readBlocks(editor.document as any[]).join('\n\n')
  })
  return normalizeBodyText(text)
}

export async function expectNoteBody(page: Page, expectedBody: string): Promise<void> {
  await expect.poll(() => readNoteBodyText(page)).toBe(normalizeBodyText(expectedBody))
}

export async function expectNoteBodiesEqual(
  pageA: Page,
  pageB: Page,
  expectedBody: string
): Promise<void> {
  const normalizedExpectedBody = normalizeBodyText(expectedBody)
  await expect
    .poll(() => Promise.all([readNoteBodyText(pageA), readNoteBodyText(pageB)]))
    .toEqual([normalizedExpectedBody, normalizedExpectedBody])
}
