// The Home journal widget's upcoming days (#2075), ported from Electron's
// `tests/e2e/home-journal-widget-upcoming.e2e.ts` (Step 30c2, #3547). The widget lists today and
// the next three local calendar days, so a future entry is visible and an empty future day is a
// navigation target. Neither case reloads: the upcoming preview arrives from the journal
// broadcast, and the click opens the journal tab on that exact date.
import {
  addJournalWidget,
  expect,
  homeReady,
  localIsoInDays,
  test,
  writeJournalEntry
} from '../../harness/home-widgets'

const UPCOMING_DAY = '[data-testid="journal-upcoming-day"]'

test.describe('Home journal widget upcoming days (#2075)', () => {
  test('lists today and the next three days, previewing a future entry', async ({ page }) => {
    await homeReady(page)
    const widget = await addJournalWidget(page)

    const rows = widget.locator(UPCOMING_DAY)
    await expect(rows).toHaveCount(4, { timeout: 20000 })

    for (let offset = 0; offset < 4; offset++) {
      await expect(rows.nth(offset)).toHaveAttribute('data-date', localIsoInDays(offset))
    }

    const futureIso = localIsoInDays(2)
    const text = `Upcoming journal ${Date.now()}`
    const futureRow = widget.locator(`${UPCOMING_DAY}[data-date="${futureIso}"]`)
    await expect(futureRow).not.toContainText(text)

    // No reload: the broadcast alone has to bring the preview into the upcoming row.
    await writeJournalEntry(page, futureIso, text)
    await expect(futureRow).toContainText(text, { timeout: 15000 })
  })

  test('clicking an empty future day opens the journal on that date', async ({ page }) => {
    await homeReady(page)
    const widget = await addJournalWidget(page)

    const targetIso = localIsoInDays(3)
    const targetRow = widget.locator(`${UPCOMING_DAY}[data-date="${targetIso}"]`)
    await expect(targetRow).toBeVisible({ timeout: 20000 })

    await targetRow.click()

    // The journal page's heading proves the tab opened on that day, not on today.
    const heading = page.locator('h1').first()
    await expect(heading).toContainText(String(Number(targetIso.slice(8))), { timeout: 20000 })
  })
})
