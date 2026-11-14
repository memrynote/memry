// On this day in the running app (#4411, Electron ea6a154b43): with today's date written in three
// years, today's entry lists the other two, newest first. All years shows each of them in full
// and read-only, and the choice is a device setting that survives a restart.
import { navigateTo, waitForAppReady } from '../../harness/app-helpers'
import { restart } from '../../harness/tauri-lifecycle'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

/** The renderer's today, as the journal page picks it. */
async function today(page: Page): Promise<string> {
  return page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })
}

/** The same day `years` away; a Feb 29 lands on Feb 28 of a non-leap year. */
function shiftYear(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) + years
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const monthDay = date.slice(5) === '02-29' && !leap ? '02-28' : date.slice(5)
  return `${year}-${monthDay}`
}

async function openJournal(page: Page): Promise<void> {
  await waitForAppReady(page)
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  await navigateTo(page, 'journal')
}

const SECTION = 'section[data-journal-past-years]'

test('On this day lists the other years, and All years shows them read-only across a restart', async ({
  app,
  page
}) => {
  await openJournal(page)
  const date = await today(page)
  const [lastYear, twoYearsAgo] = [shiftYear(date, -1), shiftYear(date, -2)]
  const create = (input: { date: string; content: string }) =>
    page.evaluate((args) => window.__TAURI__.core.invoke('journal_create_entry', args), { input })
  await create({ date, content: 'Today, in this year.' })
  await create({ date: lastYear, content: 'A swim in the lake.' })
  await create({ date: twoYearsAgo, content: 'Snow on the hills.' })

  const section = page.locator(SECTION)
  await expect(section).toBeVisible()
  await expect(section.getByText('2 other years', { exact: true })).toBeVisible()
  const rows = section.getByRole('button', { name: /^Open \d{4}-\d{2}-\d{2}$/ })
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('aria-label', `Open ${lastYear}`)
  await expect(rows.nth(1)).toHaveAttribute('aria-label', `Open ${twoYearsAgo}`)
  await expect(section.getByText('A swim in the lake.')).toBeVisible()

  await section.getByRole('button', { name: 'All years', exact: true }).click()
  await expect(section.getByRole('button', { name: 'Previews', exact: true })).toBeVisible()
  await expect(section.locator('article')).toHaveCount(2)
  await expect(section.getByText('Snow on the hills.')).toBeVisible()
  // Only the open day is editable: the other years' bodies take no input.
  await expect(section.locator('[contenteditable="true"]')).toHaveCount(0)

  await restart(app)
  await openJournal(page)
  await expect(page.locator(SECTION).locator('article')).toHaveCount(2)
  await expect(
    page.locator(SECTION).getByRole('button', { name: 'Previews', exact: true })
  ).toBeVisible()
})
