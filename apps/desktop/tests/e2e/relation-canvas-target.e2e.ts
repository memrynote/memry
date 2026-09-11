/**
 * Relation targets beyond notes/tasks/events (#2079).
 *
 * The relation picker used to search only notes, tasks and events, so a canvas
 * could not be related to at all. This walks the whole seam in the real app:
 * the picker finds the canvas, selecting it writes a `memry://canvas/<id>` URI
 * that survives a reload as a chip, and clicking the chip opens that canvas.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { seedNote } from './utils/electron-helpers'
import { ready } from './utils/desktop-test-helpers'
import { openNoteByHandle } from './utils/note-sync-helpers'

/** Creates a canvas straight through the IPC bridge — the UI path is not what is under test. */
async function seedCanvas(page: Page, title: string): Promise<void> {
  await page.evaluate(async (name) => {
    await window.api.canvas.create({ title: name })
  }, title)
}

async function addRelationPropertyThroughUi(page: Page): Promise<void> {
  await page.locator('.group\\/metadata').first().hover()

  const addPropertyButton = page.getByRole('button', { name: 'Add property' }).first()
  await expect(addPropertyButton).toBeVisible()
  await addPropertyButton.click()

  await page.getByRole('option', { name: 'Relation', exact: true }).first().click()
}

test.describe('Relation property canvas targets', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('a canvas can be related to, survives a reload and opens from its chip', async ({
    page
  }) => {
    const canvasTitle = `Relation Canvas ${Date.now()}`
    await seedCanvas(page, canvasTitle)

    const title = `Relation Target ${Date.now()}`
    const id = await seedNote(page, title)
    await openNoteByHandle(page, { id, title })

    await addRelationPropertyThroughUi(page)

    const addRelation = page.getByRole('button', { name: 'Add relation' }).first()
    await expect(addRelation).toBeVisible()
    await addRelation.click()

    await page.getByRole('textbox').last().fill(canvasTitle)
    await page.getByRole('option', { name: canvasTitle, exact: true }).first().click()

    const chip = page.getByRole('button', { name: canvasTitle, exact: true }).first()
    await expect(chip).toBeVisible()

    // Reload proves the URI reached the note's frontmatter rather than living
    // in component state, and that it resolves back to a titled chip.
    await page.reload()
    await ready(page)
    await openNoteByHandle(page, { id, title })

    const reloadedChip = page.getByRole('button', { name: canvasTitle, exact: true }).first()
    await expect(reloadedChip).toBeVisible()

    await reloadedChip.click()
    await expect(page.getByRole('tab', { name: canvasTitle })).toBeVisible({ timeout: 20000 })
  })
})
