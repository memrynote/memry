// The Home journal widget picks up journal edits (#2083), ported from Electron's
// `tests/e2e/home-journal-widget-refresh.e2e.ts` (Step 30c2, #3547). A tab group mounts only its
// active tab, so an edit made on the Journal tab reaches the board only through the app-level
// `useJournalChangeEvents` listener (App.tsx). Both cases assert the widget catches up with no
// reload and no relaunch: a reload would refetch everything and prove nothing.
import { navigateTo, setOpenPagesInNewTab } from '../../harness/app-helpers'
import {
  HOME_SEL,
  addJournalWidget,
  expect,
  homeReady,
  localIsoInDays,
  test,
  writeJournalEntry
} from '../../harness/home-widgets'

test.describe('Home journal widget picks up journal edits (#2083)', () => {
  test('text added while the board is the active tab appears without a refresh', async ({
    page
  }) => {
    await homeReady(page)
    const widget = await addJournalWidget(page)

    const text = `Journal widget refresh ${Date.now()}`
    await expect(widget.getByText(text)).toHaveCount(0)

    await writeJournalEntry(page, localIsoInDays(0), text)

    // No reload: the broadcast alone has to bring the preview in.
    await expect(widget.getByText(text)).toHaveCount(1, { timeout: 15000 })
  })

  test('text added on the Journal tab appears when the board comes back', async ({ page }) => {
    await homeReady(page)
    await addJournalWidget(page)

    // Keep the Home tab in the strip so switching away only unmounts it.
    await setOpenPagesInNewTab(page, true)

    const text = `Background board journal ${Date.now()}`
    await expect(page.locator(HOME_SEL.journalWidget).getByText(text)).toHaveCount(0)

    await navigateTo(page, 'journal')
    // The board is a background tab now, so its widgets are unmounted.
    await expect(page.locator(HOME_SEL.journalWidget)).toHaveCount(0)

    await writeJournalEntry(page, localIsoInDays(0), text)

    await page.locator(HOME_SEL.tab).filter({ hasText: 'Home' }).first().click()
    await expect(page.locator(HOME_SEL.homePage)).toBeVisible({ timeout: 20000 })

    // Still no reload: only the app-level listener marks the board's entry and heatmap queries
    // invalid while they are inside their staleTime.
    await expect(page.locator(HOME_SEL.journalWidget).getByText(text)).toHaveCount(1, {
      timeout: 15000
    })
  })
})
