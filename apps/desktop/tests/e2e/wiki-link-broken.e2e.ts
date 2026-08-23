/**
 * #1716 — broken wiki links are visible, and clicking one asks before creating.
 *
 * Before this, a `[[Ghost]]` looked exactly like a live link and a click
 * silently minted a duplicate note — the rename-rot failure mode. Now the chip
 * carries `.wiki-link-broken` (applied by a decoration plugin fed from one
 * batch `notes:resolve-titles` call per editor mount) and a click opens an
 * AlertDialog; Cancel creates nothing, Create keeps the old auto-create
 * semantics byte for byte.
 *
 * E2E because the claim spans the whole chain: main's batch resolver over the
 * real index DB, the renderer's decoration plugin on a real editor, and the
 * dialog gating a real `notes.create`. (`graph-links.e2e.ts` asserts link rows
 * via `window.api` only and is unaffected by any of this.)
 */

import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'
import { SELECTORS } from './utils/electron-helpers'
import type { Page } from '@playwright/test'

interface SeededLinks {
  sourceTitle: string
  realTarget: string
  ghostTarget: string
}

/** One note holding a live link and a dead one, side by side. */
async function seedMixedLinks(page: Page): Promise<SeededLinks> {
  const realTarget = uniqueLabel('Live Target')
  const ghostTarget = uniqueLabel('Ghost Target')
  const sourceTitle = uniqueLabel('Broken Link Source')

  await page.evaluate(
    async ({ sourceTitle, realTarget, ghostTarget }) => {
      const real = await window.api.notes.create({ title: realTarget, content: 'A target.\n' })
      const source = await window.api.notes.create({
        title: sourceTitle,
        content: `A live link [[${realTarget}]] and a dead one [[${ghostTarget}]].\n`
      })
      if (!real.success || !source.success) throw new Error('failed to seed the link pair')
    },
    { sourceTitle, realTarget, ghostTarget }
  )

  return { sourceTitle, realTarget, ghostTarget }
}

async function openNote(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

/** The chip for a target, whether the class landed on the chip or a wrapper. */
function brokenChip(page: Page, target: string) {
  return page.locator(`.wiki-link-broken[data-target="${target}"]`)
}

test.describe('Broken wiki links', () => {
  test('a dead link is styled broken and a live one is not', async ({ page }) => {
    await ready(page)
    const { sourceTitle, realTarget, ghostTarget } = await seedMixedLinks(page)

    await openNote(page, sourceTitle)

    // The batch resolve runs after mount, so the class arrives asynchronously.
    await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(`[data-wiki-link][data-target="${realTarget}"]`)).toBeVisible()
    await expect(brokenChip(page, realTarget)).toHaveCount(0)
  })

  test('clicking a dead link opens the confirm dialog; Cancel creates nothing', async ({
    page
  }) => {
    await ready(page)
    const { sourceTitle, ghostTarget } = await seedMixedLinks(page)
    await openNote(page, sourceTitle)
    await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })

    await page.locator(`[data-wiki-link][data-target="${ghostTarget}"]`).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(ghostTarget)

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()

    // Still on the source note, and the ghost still resolves to nothing.
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(sourceTitle)
    expect(
      await page.evaluate((title) => window.api.notes.resolveByTitle(title), ghostTarget)
    ).toBeNull()
  })

  test('Create makes the note, opens it, and the source restyles the link', async ({ page }) => {
    await ready(page)
    const { sourceTitle, ghostTarget } = await seedMixedLinks(page)
    await openNote(page, sourceTitle)
    await expect(brokenChip(page, ghostTarget)).toBeVisible({ timeout: 15_000 })

    await page.locator(`[data-wiki-link][data-target="${ghostTarget}"]`).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Create' }).click()

    // The new note opens, exactly like the old auto-create did.
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(ghostTarget, {
      timeout: 15_000
    })
    expect(
      await page.evaluate((title) => window.api.notes.resolveByTitle(title), ghostTarget)
    ).not.toBeNull()

    // Back on the source, the `notes:created` event has re-resolved the batch
    // and the link is no longer styled broken — no reload needed.
    await openNote(page, sourceTitle)
    await expect(page.locator(`[data-wiki-link][data-target="${ghostTarget}"]`)).toBeVisible()
    await expect(brokenChip(page, ghostTarget)).toHaveCount(0, { timeout: 15_000 })
  })
})
