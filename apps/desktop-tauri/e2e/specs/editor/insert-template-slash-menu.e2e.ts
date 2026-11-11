// Insert template from the `/` menu, ported from Electron's `insert-template-slash-menu.e2e.ts`
// (Step 14k, #3531): the template lands at the caret and the rest of the note stays.
import {
  blockTexts,
  expectSuggestionMenuOpen,
  openNewNote,
  paragraphs,
  setBlocks,
  typeInEditor
} from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const label = (prefix: string): string => `${prefix} ${Date.now().toString(36)}`

async function createTemplate(page: Page, name: string, content: string): Promise<void> {
  await invoke(page, 'templates_create', {
    input: { name, description: 'Inserted from the slash menu', content }
  })
}

test('inserts a template at the caret and leaves the rest of the note alone', async ({ page }) => {
  await vaultOpen(page)
  const templateName = label('Insert Me')
  await createTemplate(page, templateName, '## Agenda\n\nDiscuss {{title}}')
  const noteTitle = label('Insert Template')
  await openNewNote(page, noteTitle)
  await page.locator(NOTE_EDITOR).first().click()
  await setBlocks(page, paragraphs(['Above the caret', '', 'Below the caret']), 1)

  await typeInEditor(page, `/${templateName}`)
  await expectSuggestionMenuOpen(page, templateName)
  await page.keyboard.press('Enter')

  await expect
    .poll(() => blockTexts(page))
    .toEqual(['Above the caret', 'Agenda', `Discuss ${noteTitle}`, 'Below the caret'])
})

test('keeps the paragraph the caret was in when it already has text', async ({ page }) => {
  await vaultOpen(page)
  const templateName = label('Append Me')
  await createTemplate(page, templateName, 'Template line')
  await openNewNote(page, label('Insert Template Keeps'))
  await page.locator(NOTE_EDITOR).first().click()
  await setBlocks(page, paragraphs(['Keep me', 'Below the caret']), 0)

  await typeInEditor(page, ` /${templateName}`)
  await expectSuggestionMenuOpen(page, templateName)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () => (await blockTexts(page)).map((text) => text.trimEnd()))
    .toEqual(['Keep me', 'Template line', 'Below the caret'])
})
