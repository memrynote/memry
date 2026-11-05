// Broken wiki links are visible, and clicking one asks before creating (#1716), ported from
// Electron's `wiki-link-broken.e2e.ts` (Step 13q-5, #3530).
//
// A `[[Ghost]]` used to look like a live link, and a click silently made a duplicate note. The
// chip now carries `.wiki-link-broken`, painted from one `notes_resolve_titles` call per editor
// mount, and a click opens a confirm dialog: Cancel creates nothing, Create makes the note.
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const NOTE_TITLE = 'textarea[aria-label="Note title"]'
const NOTE_EDITOR = '[aria-label="Rich text editor"] [contenteditable="true"]'

interface NoteView {
  id: string
  title: string
}

interface Seeded {
  source: NoteView
  realTarget: string
  ghostTarget: string
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** One note holding a live link and a dead one, side by side. */
async function seedMixedLinks(page: Page): Promise<Seeded> {
  const realTarget = `Live Target ${stamp()}`
  const ghostTarget = `Ghost Target ${stamp()}`
  await invoke(page, 'notes_create', { input: { title: realTarget, content: 'A target.\n' } })
  const source = await invoke<NoteView>(page, 'notes_create', {
    input: {
      title: `Broken Link Source ${stamp()}`,
      content: `A live link [[${realTarget}]] and a dead one [[${ghostTarget}]].\n`
    }
  })
  return { source, realTarget, ghostTarget }
}

/** Opens a vault-root note from the Collections tree, as a user does. */
async function openFromSidebar(page: Page, note: NoteView): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  // The section opens through a 100 ms transition inside an overflow-hidden box. The driver
  // scrolls a row it clicks into view, which scrolls that box mid-transition; the box springs
  // back when the transition ends and the click lands on the row above.
  await expect
    .poll(() =>
      page
        .locator('#section-content-collections > div')
        .evaluate(
          (box: HTMLElement) => box.clientHeight > 0 && box.scrollHeight <= box.clientHeight
        )
    )
    .toBe(true)
  await page.locator(`[data-tree-node-id="${note.id}"]`).click()
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(note.title)
  await expect(page.locator(NOTE_EDITOR).first()).toBeVisible()
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
  await ready(page)
  const { source, realTarget, ghostTarget } = await seedMixedLinks(page)
  await openFromSidebar(page, source)

  // The batch resolve runs after mount, so the class arrives asynchronously.
  await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })
  await expect(chip(page, realTarget)).toBeVisible()
  await expect(brokenChip(page, realTarget)).toHaveCount(0)
})

test('clicking a dead link opens the confirm dialog; Cancel creates nothing', async ({ page }) => {
  await ready(page)
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
  await ready(page)
  const { source, ghostTarget } = await seedMixedLinks(page)
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
  await expect(chip(page, ghostTarget)).toBeVisible()
  await expect(brokenChip(page, ghostTarget)).toHaveCount(0, { timeout: 15_000 })
})
