// Search and the command palette (Electron `tests/e2e/search-command-palette.e2e.ts`, #3540): a
// note is found by the `search_*` commands and the palette, a result opened from search lists in
// the recents, and the palette's ⌘3 Tasks scope hides the note. Electron's task and inbox legs wait
// for the tasks and inbox commands, which are not ported yet.
import { appReady } from '../../harness/app-ready'
import { createNote, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Found {
  groups: Array<{ results: Array<{ id: string; title: string }> }>
}

interface Reason {
  itemId: string
  itemIcon: string | null
}

test('a note is found by search and the palette, and listed once opened', async ({ page }) => {
  await appReady(page)
  await vaultOpen(page)
  const suffix = Math.random().toString(36).slice(2, 8)
  const tag = `e2esearch${suffix}`
  const title = `Search Note ${suffix}`
  const note = await createNote(page, {
    title,
    content: 'Note body for search coverage.',
    tags: [tag],
    emoji: '🔎'
  })

  await expect
    .poll(
      async () => {
        const found = await invoke<Found>(page, 'search_query', {
          input: { text: title, types: ['note'], tags: [tag], limit: 10 }
        })
        return found.groups.flatMap((group) => group.results).map((item) => item.title)
      },
      { timeout: 20_000 }
    )
    .toContain(title)

  await invoke(page, 'search_add_reason', {
    input: { itemId: note.id, itemType: 'note', itemTitle: title, searchQuery: 'search note' }
  })
  const reasons = await invoke<Reason[]>(page, 'search_get_reasons')
  expect(reasons.find((reason) => reason.itemId === note.id)?.itemIcon).toBe('🔎')

  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.keyboard.press(`${MOD}+k`)
  const input = page.locator('[cmdk-input]')
  await expect(input).toBeVisible()
  await input.fill(title)
  const dialog = page.locator('[cmdk-root]')
  await expect(dialog.getByText(title, { exact: true }).first()).toBeVisible()
  // The palette scopes types from the keyboard since #2823; ⌘3 is Tasks.
  await page.keyboard.press(`${MOD}+3`)
  await expect(dialog.getByRole('button', { name: /^Remove Tasks?$/ })).toBeVisible()
  await expect(dialog.getByText(title, { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
})
