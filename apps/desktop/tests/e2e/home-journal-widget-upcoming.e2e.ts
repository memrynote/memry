// @ts-nocheck - E2E specs run outside the app tsconfig; `page` is fixture-typed.
/**
 * Home journal widget upcoming days (#2075)
 *
 * The widget used to look only backwards: a seven-day history strip and the most
 * recent entries. It now also lists today plus the next three local calendar days,
 * so a future entry is visible and an empty future day is still a navigation target.
 *
 * Both cases run without a reload: the upcoming previews have to arrive from the
 * journal broadcast, and the click has to open the journal tab on the exact date.
 */

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding
} from './utils/electron-helpers'

const SEL = {
  homePage: '[data-testid="home-page"]',
  grid: '.home-grid',
  widget: '[data-testid="widget"]',
  journalWidget: '[data-testid="widget"][data-widget-type="journal"]',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  addWidgetTrigger: '[data-testid="add-widget-trigger"]',
  upcomingDay: '[data-testid="journal-upcoming-day"]'
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

/** Local calendar arithmetic, matching what the widget derives from the wall clock. */
function localIsoInDays(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

async function writeEntry(page, date: string, content: string): Promise<void> {
  await page.evaluate(
    async ({ date, content }) => {
      await window.api.journal.updateEntry({ date, content })
    },
    { date, content }
  )
}

test.describe('Home journal widget upcoming days (#2075)', () => {
  test('lists today and the next three days, previewing a future entry', async ({ page }) => {
    await ready(page)
    await addJournalWidget(page)

    const widget = page.locator(SEL.journalWidget)
    const rows = widget.locator(SEL.upcomingDay)
    await expect(rows).toHaveCount(4, { timeout: 20000 })

    for (let offset = 0; offset < 4; offset++) {
      await expect(rows.nth(offset)).toHaveAttribute('data-date', localIsoInDays(offset))
    }

    const futureIso = localIsoInDays(2)
    const text = `Upcoming journal ${Date.now()}`
    const futureRow = widget.locator(`${SEL.upcomingDay}[data-date="${futureIso}"]`)
    await expect(futureRow).not.toContainText(text)

    // No reload: the broadcast alone has to bring the preview into the upcoming row.
    await writeEntry(page, futureIso, text)
    await expect(futureRow).toContainText(text, { timeout: 15000 })
  })

  test('clicking an empty future day opens the journal on that date', async ({ page }) => {
    await ready(page)
    await addJournalWidget(page)

    const widget = page.locator(SEL.journalWidget)
    const targetIso = localIsoInDays(3)
    const targetRow = widget.locator(`${SEL.upcomingDay}[data-date="${targetIso}"]`)
    await expect(targetRow).toBeVisible({ timeout: 20000 })

    await targetRow.click()

    // The journal page's own heading is the proof the tab opened on that exact day,
    // not on today.
    const heading = page.locator('h1').first()
    await expect(heading).toContainText(String(Number(targetIso.slice(8))), { timeout: 20000 })
  })
})
