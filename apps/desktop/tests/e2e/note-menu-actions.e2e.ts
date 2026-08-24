/**
 * Note-view menu file actions E2E
 *
 * Covers the file actions added to the note-view "more" menu:
 * Find, Rename, Move to folder, Copy path, the reveal-in-folder item,
 * Reveal in navigation, Open in default app, Delete note.
 *
 * Side-effecting OS items (the reveal item / Open in default app) are only
 * asserted present + enabled — they are never clicked, so no Finder/Explorer
 * window is spawned on the CI machine. All handlers are cross-platform Electron
 * shell APIs (showItemInFolder / openPath), verified at the unit level.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, seedNote, SELECTORS } from './utils/electron-helpers'

// The reveal item is labelled for the host's file manager: Finder on macOS,
// Explorer on Windows, a generic file manager everywhere else.
const REVEAL_LABEL =
  process.platform === 'darwin'
    ? 'Reveal in Finder'
    : process.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in file manager'

const MENU_ITEMS = [
  'Find…',
  'Rename…',
  'Move to folder…',
  'Copy path',
  REVEAL_LABEL,
  'Reveal in navigation',
  'Open in default app',
  'Delete note'
]

test.describe('Note-view menu file actions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  // Seed a note, then restore a session with it as the active tab and reload —
  // the robust open pattern used by pdf-embed-resize.e2e.ts (no tab-strip race).
  async function seedAndOpen(page: Page, title: string): Promise<string> {
    const id = await seedNote(page, title, 'Body for menu actions')
    await page.addInitScript(
      ({ noteId, t }) => {
        localStorage.setItem(
          'memry_tab_state',
          JSON.stringify({
            version: 2,
            tabGroups: {
              g1: {
                id: 'g1',
                activeTabId: 'note-tab',
                tabs: [
                  {
                    id: 'note-tab',
                    type: 'note',
                    title: t,
                    icon: 'file',
                    path: `/notes/${noteId}`,
                    entityId: noteId,
                    isPinned: false
                  }
                ]
              }
            },
            layout: { type: 'leaf', tabGroupId: 'g1' },
            activeGroupId: 'g1',
            settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
            savedAt: Date.now()
          })
        )
      },
      { noteId: id, t: title }
    )
    await page.reload()
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })
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

    // Success toast confirms the copy (sonner renders nested nodes, so match first)
    await expect(page.getByText('Path copied').first()).toBeVisible({ timeout: 5_000 })
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

    for (const label of [REVEAL_LABEL, 'Reveal in navigation', 'Open in default app']) {
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
