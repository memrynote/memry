// The `/` menu, ported from Electron's `slash-menu.e2e.ts` (Step 14k, #3531). Memry's own rows
// (`slash-menu.tsx`) on BlockNote's suggestion plumbing: BlockNote mounts it, the no-match
// fallback hands the query to `[[`, and a used row comes back under Recent.
import { editorDocument, openNewNote, typeInEditor } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const menu = (page: Page) => page.locator('.memry-slash-menu')

async function openFreshNote(page: Page, title: string): Promise<void> {
  await vaultOpen(page)
  await page.evaluate(() => localStorage.removeItem('memry:slash-menu-recent'))
  await openNewNote(page, title)
  await page.locator(NOTE_EDITOR).first().click()
}

test('lists the long tail at rest and shows the selected row in the action bar', async ({
  page
}) => {
  await openFreshNote(page, `Slash Rest ${Date.now()}`)

  await typeInEditor(page, '/')

  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('option', { name: 'Heading 6' })).toHaveCount(1)
  await expect(menu(page).getByRole('option', { name: /^Toggle Heading/ })).toHaveCount(0)
  await expect(menu(page).getByRole('option', { name: 'Video' })).toHaveCount(1)
  await expect(menu(page).getByText('Insert', { exact: true }).last()).toBeVisible()
})

test('a used row comes back under Recent', async ({ page }) => {
  await openFreshNote(page, `Slash Recent ${Date.now()}`)

  await typeInEditor(page, '/quote')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await editorDocument(page))[0]?.type).toBe('quote')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  await typeInEditor(page, '/')
  await expect(menu(page).getByText('Recent', { exact: true })).toBeVisible()
  await expect(menu(page).getByRole('option').first()).toHaveText(/Quote/)
})

test('no match hands the query to note search', async ({ page }) => {
  await openFreshNote(page, `Slash Fallback ${Date.now()}`)

  // Three characters, not Electron's four: BlockNote closes a menu whose query runs more than
  // three characters past the last query that loaded rows (`useCloseSuggestionMenuNoItems`). When
  // `/z` is still loading as the next character lands, its rows never load, so `zqxv` closes the
  // menu and Enter splits the paragraph (windows-x64, run 42932052609).
  await typeInEditor(page, '/zqx')
  await expect(menu(page).getByText('No blocks match “zqx”')).toBeVisible()
  await page.keyboard.press('Enter')

  await expect(menu(page)).toBeHidden()
  await expect(page.locator('.wiki-link-menu')).toBeVisible()
  await expect(page.locator(NOTE_EDITOR).first()).toContainText('[[zqx')
})
