// Broken wiki links are visible, and clicking one asks before creating (#1716), ported from
// Electron's `wiki-link-broken.e2e.ts` (Step 13q-5, #3530).
//
// A `[[Ghost]]` used to look like a live link, and a click silently made a duplicate note. The
// chip now carries `.wiki-link-broken`, painted from one `notes_resolve_titles` call per editor
// mount, and a click opens a confirm dialog: Cancel creates nothing, Create makes the note.
//
// An unbroken chip looks the same before that call answers as after, so each source also holds a
// link that stays dead. Its broken style proves an answer has painted before a chip is checked
// for having none.
import { NOTE_TITLE, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

interface NoteView {
  id: string
  path: string
  title: string
}

interface Seeded {
  source: NoteView
  realTarget: string
  ghostTarget: string
  stillMissing: string
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** One note holding a live link, a dead one, and one that stays dead, side by side. */
async function seedMixedLinks(page: Page): Promise<Seeded> {
  const realTarget = `Live Target ${stamp()}`
  const ghostTarget = `Ghost Target ${stamp()}`
  const stillMissing = `Still Missing ${stamp()}`
  await invoke(page, 'notes_create', { input: { title: realTarget, content: 'A target.\n' } })
  const source = await invoke<NoteView>(page, 'notes_create', {
    input: {
      title: `Broken Link Source ${stamp()}`,
      content:
        `A live link [[${realTarget}]] and a dead one [[${ghostTarget}]].\n\n` +
        `This one stays dead: [[${stillMissing}]].\n`
    }
  })
  return { source, realTarget, ghostTarget, stillMissing }
}

const chip = (page: Page, target: string) =>
  page.locator(`[data-wiki-link][data-target="${target}"]`)
const brokenChip = (page: Page, target: string) =>
  page.locator(`.wiki-link-broken[data-target="${target}"]`)

/**
 * Clicks a chip on its first line. A long chip wraps onto a second line on Windows, and the
 * centre of its box then falls between the two lines, on the paragraph.
 */
async function clickChip(page: Page, target: string): Promise<void> {
  const point = await chip(page, target).evaluate((element: HTMLElement) => {
    const line = element.getClientRects()[0]
    return { x: line.x + line.width / 2, y: line.y + line.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
}

const resolveByTitle = (page: Page, title: string) =>
  invoke<{ id: string; title: string } | null>(page, 'notes_resolve_by_title', { title })

test('a dead link is styled broken and a live one is not', async ({ page }) => {
  await vaultOpen(page)
  const { source, realTarget, ghostTarget } = await seedMixedLinks(page)
  await openFromSidebar(page, source)

  // The batch resolve runs after mount, so the class arrives asynchronously.
  await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })
  await expect(chip(page, realTarget)).toBeVisible()
  await expect(brokenChip(page, realTarget)).toHaveCount(0)
})

test('clicking a dead link opens the confirm dialog; Cancel creates nothing', async ({ page }) => {
  await vaultOpen(page)
  const { source, ghostTarget } = await seedMixedLinks(page)
  await openFromSidebar(page, source)
  await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })

  await clickChip(page, ghostTarget)
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(ghostTarget)

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  // Still on the source note, and the ghost still resolves to nothing.
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(source.title)
  expect(await resolveByTitle(page, ghostTarget)).toBeNull()
})

test('Create makes the note, opens it, and the source restyles the link', async ({ page }) => {
  await vaultOpen(page)
  const { source, ghostTarget, stillMissing } = await seedMixedLinks(page)
  await openFromSidebar(page, source)
  await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })

  await clickChip(page, ghostTarget)
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Create' }).click()

  // The new note opens, as the old auto-create did.
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(ghostTarget, { timeout: 15_000 })
  expect(await resolveByTitle(page, ghostTarget)).not.toBeNull()

  // Back on the source, the note-created event has re-resolved the batch and the link is no
  // longer styled broken, with no reload.
  await openFromSidebar(page, source)
  await expect(brokenChip(page, stillMissing)).toBeVisible({ timeout: 15_000 })
  await expect(chip(page, ghostTarget)).toBeVisible()
  await expect(brokenChip(page, ghostTarget)).toHaveCount(0)
})

// A note's other name is a title a link may use (13q-1, #3952). The name is added through
// `notes_edit_aliases`, as the note header's "Add another name" does; an outside `aliases:` edit
// of the file does not reach the note's record yet.
test('a link naming a note by another name is not styled broken', async ({ page }) => {
  await vaultOpen(page)
  const alias = `Other Name ${stamp()}`
  const stillMissing = `Still Missing ${stamp()}`
  const target = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Aliased Target ${stamp()}`, content: 'A target.\n' }
  })
  const names = await invoke<{ aliases: string[] }>(page, 'notes_edit_aliases', {
    input: { id: target.id, add: [alias], remove: [] }
  })
  expect(names.aliases).toEqual([alias])
  const source = await invoke<NoteView>(page, 'notes_create', {
    input: {
      title: `Alias Link Source ${stamp()}`,
      content: `By its other name [[${alias}]], and one that stays dead [[${stillMissing}]].\n`
    }
  })
  await openFromSidebar(page, source)

  await expect(brokenChip(page, stillMissing)).toBeVisible({ timeout: 15_000 })
  await expect(chip(page, alias)).toBeVisible()
  await expect(brokenChip(page, alias)).toHaveCount(0)
})
