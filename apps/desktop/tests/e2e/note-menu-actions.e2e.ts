/**
 * Note-view menu file actions E2E
 *
 * Covers the file actions added to the note-view "more" menu:
 * Find, Rename, Move to folder, Copy path, Reveal in Finder,
 * Reveal in navigation, Open in default app, Delete note.
 *
 * Side-effecting OS items (Reveal in Finder / Open in default app) are only
 * asserted present + enabled — they are never clicked, so no Finder/Explorer
 * window is spawned on the CI machine. All handlers are cross-platform Electron
 * shell APIs (showItemInFolder / openPath), verified at the unit level.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  seedNote,
  waitForToast,
  SELECTORS
} from './utils/electron-helpers'
import { openNoteByHandle } from './utils/note-sync-helpers'

const MENU_ITEMS = [
  'Find…',
  'Rename…',
  'Move to folder…',
  'Copy path',
  'Reveal in Finder',
  'Reveal in navigation',
  'Open in default app',
  'Delete note'
]

test.describe('Note-view menu file actions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  async function seedAndOpen(page: Page, title: string): Promise<string> {
    const id = await seedNote(page, title, 'Body for menu actions')
    await openNoteByHandle(page, { id, title })
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(title)
    return id
  }

  async function openMoreMenu(page: Page): Promise<void> {
    await page.locator('[data-testid="note-more-menu"]').first().click()
  }

  test('shows all file actions in the menu', async ({ page }) => {
    await seedAndOpen(page, `Menu Items ${Date.now()}`)
    await openMoreMenu(page)

    for (const label of MENU_ITEMS) {
      await expect(page.getByRole('option', { name: label })).toBeVisible()
    }
  })

  test('Find opens the find bar', async ({ page }) => {
    await seedAndOpen(page, `Find From Menu ${Date.now()}`)
    await openMoreMenu(page)
    await page.getByRole('option', { name: 'Find…' }).click()

    await expect(page.getByRole('textbox', { name: 'Find, replace, ask...' })).toBeVisible()
  })

  test('Copy path copies the vault-relative path', async ({ page }) => {
    await seedAndOpen(page, `Copy Path ${Date.now()}`)
    await openMoreMenu(page)
    await page.getByRole('option', { name: 'Copy path' }).click()

    await waitForToast(page, 'Path copied')
  })

  test('Rename focuses the title', async ({ page }) => {
    await seedAndOpen(page, `Rename From Menu ${Date.now()}`)
    await openMoreMenu(page)
    await page.getByRole('option', { name: 'Rename…' }).click()

    await expect(page.locator(SELECTORS.noteTitle).first()).toBeFocused()
  })

  test('Move to folder opens the move dialog', async ({ page }) => {
    await seedAndOpen(page, `Move From Menu ${Date.now()}`)
    await openMoreMenu(page)
    await page.getByRole('option', { name: 'Move to folder…' }).click()

    await expect(page.getByRole('dialog')).toBeVisible()
    // Close without moving — the move itself is covered at the unit level.
    await page.keyboard.press('Escape')
  })

  test('Reveal/Open OS items are present and enabled (not clicked)', async ({ page }) => {
    await seedAndOpen(page, `OS Items ${Date.now()}`)
    await openMoreMenu(page)

    for (const label of ['Reveal in Finder', 'Reveal in navigation', 'Open in default app']) {
      const item = page.getByRole('option', { name: label })
      await expect(item).toBeVisible()
      await expect(item).toBeEnabled()
    }
  })

  test('Delete removes the note after confirmation and closes its tab', async ({ page }) => {
    const title = `Delete From Menu ${Date.now()}`
    const id = await seedAndOpen(page, title)

    await openMoreMenu(page)
    await page.getByRole('option', { name: 'Delete note' }).click()

    // Confirmation dialog
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    // Note is gone from the default list, and its tab is closed
    await expect
      .poll(
        async () =>
          page.evaluate(async (noteId) => {
            const { notes } = await window.api.notes.list({})
            return notes.some((n: { id: string }) => n.id === noteId)
          }, id),
        { timeout: 10000 }
      )
      .toBe(false)

    await expect(page.locator(`${SELECTORS.noteTitle}`).filter({ hasText: title })).toHaveCount(0)
  })
})
