/**
 * #1907 — a checkbox line Memry has no `tasks` row for must never wear task
 * controls it cannot honour.
 *
 * Two bodies an Obsidian vault produces:
 *
 *   - plain checkbox lines with no `{task:<id>}` suffix. The editor converts
 *     each into a real task; if a conversion cannot complete, the line has to
 *     stay a checkbox rather than sit there as a task-shaped row over an
 *     empty id.
 *   - a `{task:<id>}` whose id resolves to no row, which is what a vault
 *     copied between installs looks like.
 *
 * The renderer marks a row it cannot act on `aria-busy` and strips its
 * controls, so "an inert control is on screen" is exactly
 * `[role="button"][aria-label*="Task:"][aria-busy="true"]` surviving after the
 * editor settles. Asserted one field at a time: `toMatchObject` hides the
 * diagnostic fields that say which row went wrong.
 *
 * Needs `BUILD_BEFORE_TEST=1` like every spec here (see global-setup.ts), or
 * it runs against a stale renderer bundle and passes on the old behaviour.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import {
  SELECTORS,
  dismissFirstRunOnboarding,
  search,
  selectSearchResult,
  seedNote,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'

// The editor debounces a checkbox→task conversion by 600ms and then makes an
// IPC round trip per line. Give the whole pass room to finish before deciding
// what is on screen.
const SETTLE_MS = 4000

const INERT_TASK_ROW = '[role="button"][aria-label*="Task:"][aria-busy="true"]'
const TASK_ROW = SELECTORS.taskItem

async function openSeededNote(page: Page, title: string, body: string): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)

  await seedNote(page, title, body)
  await search(page, title)
  await selectSearchResult(page, title)

  await page.waitForSelector(SELECTORS.noteEditor, { timeout: 20_000 })
  await page.waitForTimeout(SETTLE_MS)
}

test.describe('imported checkbox lines', () => {
  test('checkbox lines with no {task:} suffix leave no inert task row', async ({ page }) => {
    // #given a note body written by Obsidian: checkboxes, no Memry suffix
    await openSeededNote(
      page,
      'Obsidian groceries',
      [
        '# Groceries',
        '',
        '- [ ] Buy milk 2026-09-01',
        '- [x] Call the plumber',
        '- [ ] Renew the passport',
        ''
      ].join('\n')
    )

    // #then nothing on screen is a task row the app cannot act on
    expect(await page.locator(INERT_TASK_ROW).count()).toBe(0)

    // #and every line is accounted for: either a real task row or a plain
    // checklist item. A line that is neither has vanished from the note.
    const taskRows = await page.locator(TASK_ROW).count()
    const checklistItems = await page
      .locator('[data-content-type="checkListItem"], [data-node-type="checkListItem"]')
      .count()
    expect(taskRows + checklistItems).toBeGreaterThanOrEqual(3)

    // #and each task row that did render exposes a live status control
    const rows = page.locator(TASK_ROW)
    for (let index = 0; index < taskRows; index++) {
      const row = rows.nth(index)
      expect(await row.getAttribute('aria-busy')).toBeNull()
      expect(await row.locator('button:not([disabled])').count()).toBeGreaterThan(0)
    }
  })

  test('a {task:<id>} that resolves to no row says so instead of faking a task', async ({
    page
  }) => {
    // #given a vault copied from another install: the suffix is well-formed,
    // the row it names is not here
    await openSeededNote(
      page,
      'Copied vault note',
      ['# Carried over', '', '- [ ] Buy milk {task:from-another-install}', ''].join('\n')
    )

    // #then the block names its own state
    await expect(page.getByText('Task deleted')).toBeVisible({ timeout: 10_000 })

    // #and it is not dressed as a task
    expect(await page.locator(INERT_TASK_ROW).count()).toBe(0)
    expect(await page.locator(TASK_ROW).count()).toBe(0)

    // #and the only control it offers is the one that removes it, which works
    const notice = page.locator('div:has-text("Task deleted") > button').last()
    await expect(notice).toBeEnabled()
  })
})
