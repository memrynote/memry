import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

async function focusEditor(page: Page): Promise<void> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
}

async function seedDocument(page: Page, paragraphs: string[], caretIndex: number): Promise<void> {
  await page.evaluate(
    ({ paragraphs, caretIndex }) => {
      const editor = (window as any).__memryEditor
      if (!editor) throw new Error('window.__memryEditor not exposed')
      editor.replaceBlocks(
        editor.document,
        paragraphs.map((text) => ({
          type: 'paragraph',
          content: text ? [{ type: 'text', text, styles: {} }] : ''
        }))
      )
      editor.setTextCursorPosition(editor.document[caretIndex].id, 'end')
    },
    { paragraphs, caretIndex }
  )
}

async function blockTextsWithoutTrailingBlanks(page: Page): Promise<string[]> {
  const texts: string[] = await page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    return editor.document.map((block: any) =>
      Array.isArray(block.content) ? block.content.map((part: any) => part.text ?? '').join('') : ''
    )
  })
  while (texts.length > 0 && texts[texts.length - 1] === '') texts.pop()
  return texts
}

test.describe('Insert template from the slash menu E2E', () => {
  test('inserts a template at the caret and leaves the rest of the note alone', async ({
    page
  }) => {
    await ready(page)

    const templateName = uniqueLabel('Insert Me')
    await page.evaluate(async (name) => {
      const created = await window.api.templates.create({
        name,
        description: 'Inserted from the slash menu',
        content: '## Agenda\n\nDiscuss {{title}}'
      })
      if (!created.success) throw new Error(created.error ?? 'template create failed')
    }, templateName)

    const noteTitle = uniqueLabel('Insert Template')
    await createNote(page, noteTitle)

    await focusEditor(page)
    await seedDocument(page, ['Above the caret', '', 'Below the caret'], 1)

    await page.keyboard.type(`/${templateName}`)
    await expect(page.getByText(templateName).first()).toBeVisible()
    await page.keyboard.press('Enter')

    await expect
      .poll(() => blockTextsWithoutTrailingBlanks(page))
      .toEqual(['Above the caret', 'Agenda', `Discuss ${noteTitle}`, 'Below the caret'])
  })

  test('keeps the paragraph the caret was in when it already has text', async ({ page }) => {
    await ready(page)

    const templateName = uniqueLabel('Append Me')
    await page.evaluate(async (name) => {
      const created = await window.api.templates.create({
        name,
        content: 'Template line'
      })
      if (!created.success) throw new Error(created.error ?? 'template create failed')
    }, templateName)

    await createNote(page, uniqueLabel('Insert Template Keeps'))

    await focusEditor(page)
    await seedDocument(page, ['Keep me', 'Below the caret'], 0)

    await page.keyboard.type(` /${templateName}`)
    await expect(page.getByText(templateName).first()).toBeVisible()
    await page.keyboard.press('Enter')

    await expect
      .poll(() => blockTextsWithoutTrailingBlanks(page))
      .toEqual([expect.stringMatching(/^Keep me\s*$/), 'Template line', 'Below the caret'])
  })
})
