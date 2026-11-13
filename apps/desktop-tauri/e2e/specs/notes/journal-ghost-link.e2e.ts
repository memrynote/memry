// A link to a journal day nobody has written yet (#4409, Electron `b40a2a35d2`): the `[[` menu
// offers the day as a muted "not written yet" row, the link it writes is styled as a ghost, and a
// click opens the empty day in the Journal instead of offering to create a note. The empty day
// already lists the linking note in its backlinks, and reading it writes no day.
import { expectSuggestionMenuOpen, noteBody, typeInEditor } from '../../harness/editor'
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

test('a link to an unwritten day opens the empty day, which lists the note', async ({ page }) => {
  await vaultOpen(page)
  const day = '2036-05-08'
  expect(await invoke<object | null>(page, 'journal_get_entry', { date: day })).toBeNull()
  const title = `Ghost Day Source ${Math.random().toString(36).slice(2, 8)}`
  const source = await createNote(page, { title, content: 'Observed on' })
  await openNoteByTitle(page, title)

  await page.locator(NOTE_EDITOR).first().click()
  await page.keyboard.press('End')
  // A month lists only its written days; the full date offers the unwritten one.
  await typeInEditor(page, ` [[${day.slice(0, 7)}`)
  await typeInEditor(page, day.slice(7))
  const ghostRow = page.locator('.wiki-link-menu [data-journal-day="ghost"]').first()
  await expect(ghostRow).toContainText('Journal · not written yet')
  await expectSuggestionMenuOpen(page)
  await ghostRow.click()

  const chip = page.locator(`[data-wiki-link][data-target="${day}"]`).first()
  await expect(chip).toBeVisible()
  await expect(page.locator(`.wiki-link-broken[data-target="${day}"]`)).toBeVisible({
    timeout: 15_000
  })
  await expect.poll(() => noteBody(page, source.id), { timeout: 15_000 }).toContain(`[[${day}]]`)

  await chip.click()
  // The Journal opens the day, with no create-note dialog.
  await expect(page.locator('[role="tab"][data-group-id]').filter({ hasText: day })).toBeVisible({
    timeout: 15_000
  })
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const backlinks = page.locator('section[aria-label="Backlinks"]').filter({ hasText: title })
  await expect(backlinks).toBeVisible({ timeout: 15_000 })
  expect(await invoke<object | null>(page, 'journal_get_entry', { date: day })).toBeNull()
})
