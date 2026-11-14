// The reference filter on a note's linked mentions (#4410, Electron `1c99ee370a`): a note linked
// from one tagged note and one journal day lists both; Journal narrows the list to the day, the
// note's tag to the note, and All brings both back.
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

async function pickFilter(page: Page, current: string, option: string): Promise<void> {
  await page.getByRole('button', { name: `Filter references: ${current}` }).click()
  await page.getByRole('menuitem', { name: option }).click()
}

test('the reference filter narrows linked mentions to journal days or to a tag', async ({
  page
}) => {
  await vaultOpen(page)
  const suffix = Math.random().toString(36).slice(2, 8)
  const target = `Filter Target ${suffix}`
  const source = `Tagged Source ${suffix}`
  const tag = `ref${suffix}`
  const day = '2036-03-01'
  await createNote(page, { title: target, content: 'Body.' })
  await createNote(page, { title: source, content: `See [[${target}]].`, tags: [tag] })
  await invoke(page, 'journal_create_entry', {
    input: { date: day, content: `Worked on [[${target}]].` }
  })

  await openNoteByTitle(page, target)
  const backlinks = page.locator('section[aria-label="Backlinks"]')
  const card = (title: string) => backlinks.getByRole('link', { name: title })
  await expect(card(source)).toBeVisible({ timeout: 15_000 })
  await expect(card(day)).toBeVisible({ timeout: 15_000 })

  await pickFilter(page, 'All', 'Journal')
  await expect(card(day)).toBeVisible()
  await expect(card(source)).toHaveCount(0)

  await pickFilter(page, 'Journal', `#${tag}`)
  await expect(card(source)).toBeVisible()
  await expect(card(day)).toHaveCount(0)

  await pickFilter(page, `#${tag}`, 'All')
  await expect(card(source)).toBeVisible()
  await expect(card(day)).toBeVisible()
})
