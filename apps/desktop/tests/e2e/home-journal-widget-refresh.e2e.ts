// @ts-nocheck - E2E specs run outside the app tsconfig; `page` is fixture-typed.
/**
 * Home journal widget refresh (#2083)
 *
 * The reported bug: adding text to a journal entry does not refresh the Home
 * journal widget; the new content shows up only after repeatedly leaving and
 * re-entering the page.
 *
 * Root cause was the same shape as the calendar-widget bug (#1911/#1916), but a
 * separate gap: the only listeners for the main process's `journal:entry*`
 * broadcasts lived inside mounted components -- `useJournalChangeInvalidation`
 * (heatmap) and `useJournalEntry`, which patches only the one date its editor has
 * open. A tab group mounts only its active tab, so an edit made on the Journal tab
 * reached nobody on the Home board, and the board's cached heatmap and entry
 * previews were still inside their 30s `staleTime` when the tab came back.
 * `useJournalChangeEvents` now runs once in App.tsx and outlives every tab switch.
 *
 * Both cases assert the widget catches up with NO page reload and NO relaunch.
 * A reload would refetch everything and prove nothing.
 */

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding,
  navigateTo,
  setOpenPagesInNewTab
} from './utils/electron-helpers'

const SEL = {
  homePage: '[data-testid="home-page"]',
  grid: '.home-grid',
  widget: '[data-testid="widget"]',
  journalWidget: '[data-testid="widget"][data-widget-type="journal"]',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  addWidgetTrigger: '[data-testid="add-widget-trigger"]',
  tab: '[role="tab"][data-group-id]'
}

async function ready(page) {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
  await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
  await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
}

async function addJournalWidget(page) {
  const trigger = page.locator(SEL.addWidgetTrigger)
  await expect(trigger).toBeVisible({ timeout: 20000 })
  await trigger.click()
  await expect(page.locator(SEL.gallery)).toBeVisible({ timeout: 20000 })
  await page.locator(`${SEL.galleryItem}[data-widget-type="journal"]`).click()
  await expect(page.locator(SEL.gallery)).toBeHidden({ timeout: 20000 })
  await expect(page.locator(SEL.journalWidget)).toBeVisible({ timeout: 20000 })
}

/** The widget derives its own "today" from the local wall clock, not from UTC. */
function todayLocalIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
}

/** Write a journal entry through the same IPC the journal editor's autosave calls. */
async function writeEntry(page, date: string, content: string): Promise<void> {
  await page.evaluate(
    async ({ date, content }) => {
      await window.api.journal.updateEntry({ date, content })
    },
    { date, content }
  )
}

test.describe('Home journal widget picks up journal edits (#2083)', () => {
  test('text added while the board is the active tab appears without a refresh', async ({
    page
  }) => {
    await ready(page)
    await addJournalWidget(page)

    const text = `Journal widget refresh ${Date.now()}`
    const widget = page.locator(SEL.journalWidget)
    await expect(widget.getByText(text)).toHaveCount(0)

    await writeEntry(page, todayLocalIso(), text)

    // No reload: the broadcast alone has to bring the preview in.
    await expect(widget.getByText(text)).toHaveCount(1, { timeout: 15000 })
  })

  test('text added on the Journal tab appears when the board comes back', async ({ page }) => {
    await ready(page)
    await addJournalWidget(page)

    // Keep the Home tab alive in the strip so switching away only unmounts it.
    await setOpenPagesInNewTab(page, true)

    const text = `Background board journal ${Date.now()}`
    await expect(page.locator(SEL.journalWidget).getByText(text)).toHaveCount(0)

    await navigateTo(page, 'journal')
    // The board is now a background tab, so its widgets are unmounted.
    await expect(page.locator(SEL.journalWidget)).toHaveCount(0)

    await writeEntry(page, todayLocalIso(), text)

    await page.locator(SEL.tab).filter({ hasText: 'Home' }).first().click()
    await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })

    // Still no reload. Before the fix this preview never arrived: nothing listening
    // marked the board's entry and heatmap queries invalid, and both were still
    // inside their staleTime.
    await expect(page.locator(SEL.journalWidget).getByText(text)).toHaveCount(1, {
      timeout: 15000
    })
  })
})
