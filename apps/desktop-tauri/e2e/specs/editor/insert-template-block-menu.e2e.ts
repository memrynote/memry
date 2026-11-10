// Insert template from the block side menu, ported from Electron's
// `insert-template-block-menu.e2e.ts` (Step 14k, #3531): the template lands below the hovered
// block, and an empty hovered block is kept rather than replaced.
import { blockTexts, openNewNote, paragraphs, setBlocks } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const label = (prefix: string): string => `${prefix} ${Date.now().toString(36)}`

async function seedNote(page: Page, template: string, content: string, blocks: string[]) {
  await vaultOpen(page)
  await invoke(page, 'templates_create', {
    input: { name: template, description: 'Inserted from the block menu', content }
  })
  const note = await openNewNote(page, label('Block Menu Insert'))
  await page.locator(NOTE_EDITOR).first().click()
  await setBlocks(page, paragraphs(blocks))
  return note
}

async function insertTemplateBelow(page: Page, blockIndex: number, template: string) {
  await page.locator('.bn-block-content').nth(blockIndex).hover()
  await page.locator('[data-test="dragHandle"]').first().click()
  await page
    .getByRole('menuitem', { name: /Insert template/ })
    .first()
    .click()
  const search = page.getByPlaceholder('Search templates...')
  await expect(search).toBeVisible()
  await search.fill(template)
  await page
    .getByRole('button', { name: new RegExp(template) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Apply Template' }).click()
}

test('lands the template below the hovered block and keeps every other block', async ({ page }) => {
  const template = label('Block Menu Template')
  const note = await seedNote(page, template, '## Agenda\n\nDiscuss {{title}}', [
    'First',
    'Second',
    'Third'
  ])

  await insertTemplateBelow(page, 0, template)

  await expect
    .poll(() => blockTexts(page))
    .toEqual(['First', 'Agenda', `Discuss ${note.title}`, 'Second', 'Third'])
})

test('keeps an empty hovered block instead of replacing it', async ({ page }) => {
  const template = label('Block Menu Keep Empty')
  await seedNote(page, template, 'Template line', ['', 'Tail'])

  await insertTemplateBelow(page, 0, template)

  await expect.poll(() => blockTexts(page)).toEqual(['', 'Template line', 'Tail'])
})
