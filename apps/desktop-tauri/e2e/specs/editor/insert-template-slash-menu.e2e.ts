// Insert template from the `/` menu, ported from Electron's `insert-template-slash-menu.e2e.ts`
// (Step 14k, #3531): the template lands at the caret and the rest of the note stays.
import { blockTexts, openNewNote, paragraphs, setBlocks, typeInEditor } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const label = (prefix: string): string => `${prefix} ${Date.now().toString(36)}`

/**
 * Waits until the `/` menu is open and points at the template's row, the row Enter runs. The
 * typed query holds the template's name too, so a wait on its text alone passes before the menu
 * opens (windows-x64, run 42916206983). The row alone is not proof either: a closing menu keeps
 * rendering its last rows with no key handler attached. The editor's `aria-expanded` and
 * `aria-activedescendant` are set only while the menu's keyboard handler is mounted (#3967).
 */
async function expectTemplateRowSelected(page: Page, name: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ([editorSelector, rowName]: [string, string]) => {
          const editor = document.querySelector(editorSelector)
          const rowId = editor?.getAttribute('aria-activedescendant')
          const row = rowId ? document.getElementById(rowId) : null
          return (
            editor?.getAttribute('aria-expanded') === 'true' &&
            row?.getAttribute('aria-selected') === 'true' &&
            (row.textContent ?? '').includes(rowName)
          )
        },
        [NOTE_EDITOR, name]
      )
    )
    .toBe(true)
}

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
  await expectTemplateRowSelected(page, templateName)
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
  await expectTemplateRowSelected(page, templateName)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () => (await blockTexts(page)).map((text) => text.trimEnd()))
    .toEqual(['Keep me', 'Template line', 'Below the caret'])
})
