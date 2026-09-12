import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

async function focusEditor(page: Page): Promise<void> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
}

async function seedDocument(page: Page, paragraphs: string[]): Promise<void> {
  await page.evaluate((paragraphs) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(
      editor.document,
      paragraphs.map((text) => ({
        type: 'paragraph',
        content: text ? [{ type: 'text', text, styles: {} }] : ''
      }))
    )
  }, paragraphs)
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

async function openDragHandleMenu(page: Page, blockIndex: number): Promise<void> {
  await page.locator('.bn-block-content').nth(blockIndex).hover()
  const handle = page.locator('[data-test="dragHandle"]').first()
  await handle.waitFor({ state: 'visible', timeout: 5_000 })
  await handle.click()
  await page.locator('[role="menu"]').first().waitFor({ state: 'visible', timeout: 5_000 })
}

async function createTemplate(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(
    async ({ name, content }) => {
      const created = await window.api.templates.create({
        name,
        description: 'Inserted from the block menu',
        content
      })
      if (!created.success) throw new Error(created.error ?? 'template create failed')
    },
    { name, content }
  )
}

async function pickTemplate(page: Page, templateName: string): Promise<void> {
  await page
    .getByRole('menuitem', { name: /Insert template/ })
    .first()
    .click()
  const search = page.getByPlaceholder('Search templates...')
  await search.waitFor({ state: 'visible', timeout: 5_000 })
  await search.fill(templateName)
  await page
    .getByRole('button', { name: new RegExp(templateName) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Apply Template' }).click()
}

test.describe('Insert template from the block side menu E2E', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('lands the template below the hovered block and keeps every other block', async ({
    page
  }) => {
    const templateName = uniqueLabel('Block Menu Template')
    await createTemplate(page, templateName, '## Agenda\n\nDiscuss {{title}}')

    const noteTitle = uniqueLabel('Block Menu Insert')
    await createNote(page, noteTitle)

    await focusEditor(page)
    await seedDocument(page, ['First', 'Second', 'Third'])

    await openDragHandleMenu(page, 0)
    await pickTemplate(page, templateName)

    await expect
      .poll(() => blockTextsWithoutTrailingBlanks(page))
      .toEqual(['First', 'Agenda', `Discuss ${noteTitle}`, 'Second', 'Third'])
  })

  test('keeps an empty hovered block instead of replacing it', async ({ page }) => {
    const templateName = uniqueLabel('Block Menu Keep Empty')
    await createTemplate(page, templateName, 'Template line')

    await createNote(page, uniqueLabel('Block Menu Keeps Empty'))

    await focusEditor(page)
    await seedDocument(page, ['', 'Tail'])

    await openDragHandleMenu(page, 0)
    await pickTemplate(page, templateName)

    await expect
      .poll(() => blockTextsWithoutTrailingBlanks(page))
      .toEqual(['', 'Template line', 'Tail'])
  })
})
