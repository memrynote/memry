// Calendar subscriptions: Settings > Modules > Calendar lists Google, subscribed calendars, CalDAV
// and This Mac. Maya pastes Apple's public US holidays link (webcal, fetched live, no sign-in),
// and Halloween and the end of daylight saving land in her Lisbon week as a subscribed calendar.
import { day } from '../../vault/cli.mjs'
import { settle } from '../../engine/kit.mjs'

const LINK = 'webcal://p01-calendars.icloud.com/holiday/US_en.ics'
const rail = (page, name) =>
  page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true })

export async function setup({ page }) {
  await rail(page, 'Calendar').click()
  await page.waitForTimeout(1200)
  const tab = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  for (let i = 0; i < 6; i++) {
    const tabs = await tab.evaluateAll((els) => els.map((e) => e.textContent.trim()))
    const other = tabs.findIndex((t) => !/Calendar/.test(t))
    if (other < 0) break
    await tab.nth(other).click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
  await page.getByRole('button', { name: 'Toggle Sidebar' }).last().click()
  await page.waitForTimeout(400)
  // The week of the Lisbon trip, which ends on the weekend the holidays fall on.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.waitForTimeout(800)
  const monday = new Date(`${day(9)}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
  await page.getByRole('button', { name: monday, exact: true }).click()
  await page.waitForTimeout(1000)
  await page.mouse.move(800, 600)
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count())
    await page.keyboard.press('Meta+Shift+B')
  await page.waitForTimeout(600)
  // From 7 AM, so the flight that opens the trip shows its title.
  await page.mouse.wheel(0, -110)
  await page.waitForTimeout(500)
  // Settings > Modules > Calendar, where calendars are connected.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: 'Modules', exact: true }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Configure Calendar' }).click()
  await page.waitForTimeout(1000)
  // The link Maya copied from Apple's public holiday calendars.
  await page.evaluate((link) => navigator.clipboard.writeText(link), LINK)
  await settle(page, 820, 300)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.5)
    await rec.glide(900, 520, 1500)
  },
  async list({ rec, page, zoom, at }) {
    zoom(950, 615, 1.6)
    await at(0.5)
    for (const name of ['This Mac', 'CalDAV', 'Subscribed calendars']) {
      const c = await rec.center(page.getByRole('button', { name, exact: true }))
      await rec.glide(c.x - 180, c.y, 650)
    }
  },
  async paste({ rec, page, zoom, at, sleep }) {
    zoom(950, 650, 1.6)
    await rec.click(page.getByRole('button', { name: 'Subscribed calendars', exact: true }), {
      dx: -180
    })
    const field = page.getByRole('textbox', { name: 'Calendar link' })
    await field.waitFor()
    await sleep(450)
    await rec.click(field, { dx: -120 })
    await sleep(350)
    await rec.key('Meta+v')
    await sleep(600)
    await rec.click(page.getByRole('button', { name: 'Subscribe', exact: true }))
    await page.getByRole('list', { name: 'Subscribed calendars' }).waitFor({ timeout: 20000 })
  },
  // No caption: the toast that counts the events sits at the window's bottom edge, where any
  // step caption would cover it.
  async added({ rec, page, zoom }) {
    zoom(1065, 650, 1.5)
    const row = await rec.center(page.getByText('US Holidays', { exact: true }))
    await rec.glide(row.x + 20, row.y + 22, 800)
  },
  async week({ rec, page, zoom, unzoom, at, sleep }) {
    unzoom()
    await sleep(300)
    await rec.click(rail(page, 'Calendar'))
    const halloween = page.getByText('Halloween', { exact: true })
    await halloween.waitFor()
    await sleep(400)
    zoom(1240, 230, 1.8)
    await at(2.6)
    await rec.click(halloween, { dx: -30 })
    await page.getByRole('dialog', { name: 'Subscribed calendar' }).waitFor()
    await sleep(500)
    await rec.glide(1300, 330, 700)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'US Holidays is subscribed and its Halloween is in the database',
    (query) => {
      const [s] = query("SELECT id, title FROM calendar_sources WHERE provider = 'ics'")
      if (s?.title !== 'US Holidays') return `source: ${JSON.stringify(s)}`
      const [e] = query(
        `SELECT COUNT(*) AS n FROM calendar_external_events WHERE source_id = '${s.id}' AND title = 'Halloween'`
      )
      return e?.n > 0 ? null : 'no Halloween event'
    }
  ]
]
