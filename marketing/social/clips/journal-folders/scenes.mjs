// Journal folders: the journal folder (shown in the sidebar, flat: a year and a half of days in
// one list) gets a date format with slashes in Settings > Modules > Journal, and the app files
// every entry under its year and month (the shipped format migration). Setup only turns on "Show
// in sidebar" and opens the folder, both ordinary settings.
import { closeOtherTabs, settle } from '../../engine/kit.mjs'

const FORMAT = 'YYYY/MMMM/YYYY-MM-DD'

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.getByRole('button', { name: 'Modules', exact: true }).click()
  await page.getByRole('button', { name: 'Configure Journal' }).click()
  const toggle = page.getByRole('switch', { name: 'Show in sidebar' })
  await toggle.waitFor()
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page.waitForTimeout(900)
  await closeOtherTabs(page, 'Journal')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const section = page.getByRole('button', { name: /^Collections section, collapsed/ })
  if (await section.count()) await section.first().click()
  await page.waitForTimeout(500)
  await expandJournal(page)
  await settle(page, 900, 600)
}

/** The journal folder's row in the sidebar, expanded. */
async function expandJournal(page) {
  const row = page.getByText('journal', { exact: true }).first()
  const b = await row.boundingBox()
  const buttons = page.getByRole('button', { name: 'Expand folder' })
  for (let i = 0; i < (await buttons.count()); i++) {
    const e = await buttons.nth(i).boundingBox()
    if (e && Math.abs(e.y + e.height / 2 - (b.y + b.height / 2)) < 10) {
      await buttons.nth(i).click()
      await page.waitForTimeout(500)
      return
    }
  }
}

const gear = (page) => page.getByRole('button', { name: 'Settings', exact: true }).first()
const formatInput = (page) => page.locator('input[placeholder=YYYY-MM-DD]')
const preview = (page) => page.getByText(/^journal\/.*\.md$/)

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(gear(page))
    await rec.glide(300, 560, 900)
    await rec.glide(c.x + 40, c.y - 60, 1100)
  },
  async open({ rec, page, zoom, unzoom, sleep }) {
    await rec.click(gear(page))
    await page.getByRole('button', { name: 'Modules', exact: true }).waitFor()
    await sleep(200)
    await rec.click(page.getByRole('button', { name: 'Modules', exact: true }))
    const cfg = page.getByRole('button', { name: 'Configure Journal' })
    await cfg.waitFor()
    await sleep(300)
    await rec.click(cfg)
    await formatInput(page).waitFor()
    await sleep(300)
    zoom(1000, 470, 1.6)
    await rec.glide(1110, 560, 700)
  },
  async format({ rec, page, sleep, at }) {
    await rec.click(formatInput(page))
    await sleep(250)
    await rec.key('Meta+a')
    await rec.type(FORMAT, { cps: 12 })
    await sleep(500)
    await rec.key('Tab')
    await preview(page).filter({ hasText: '2026/October' }).waitFor()
    await sleep(400)
    const p = await preview(page).boundingBox()
    await rec.glide(p.x + p.width + 60, p.y + 60, 900)
    await at(6.2)
  },
  async folders({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(350)
    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    await page.waitForTimeout(1200)
    zoom(300, 420, 1.5)
    await sleep(400)
    await at(3.0)
    const year = page.getByText('2026', { exact: true }).first()
    await year.waitFor()
    await rec.click(year)
    await sleep(500)
    const oct = page.getByText('October', { exact: true }).first()
    await rec.click(oct)
    await at(7.2)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
