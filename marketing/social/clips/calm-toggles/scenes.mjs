// Settings -> Modules ("Turn parts of the app on or off") has one switch per feature. Maya turns
// off Inbox, Journal, Tasks, Calendar, Graph and Canvas one by one: their icons and the red count
// badges on Inbox and Tasks leave the rail, and a bare notes editor is left. Setup switches every
// module back on first, because the app keeps the setting between takes.
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const NOTE = 'Weekly sync with Sam'
const OFF = ['Inbox', 'Journal', 'Tasks', 'Calendar', 'Graph', 'Canvas']
const toggle = (page, name) => page.getByRole('switch', { name, exact: true })

async function modules(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Modules', exact: true }).click()
  await page.waitForTimeout(800)
}

export async function setup({ page }) {
  await modules(page)
  for (const name of ['Home', ...OFF]) {
    const sw = toggle(page, name)
    if ((await sw.getAttribute('aria-checked')) !== 'true') {
      await sw.click()
      await page.waitForTimeout(400)
    }
  }
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page.waitForTimeout(800)
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await settle(page, 1000, 600)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const c = await rec.center(page.getByRole('button', { name: 'Settings', exact: true }))
    await rec.glide(c.x + 10, c.y - 30, 1800)
  },
  async list({ rec, page, zoom, sleep, at }) {
    await rec.click(page.getByRole('button', { name: 'Settings', exact: true }))
    await sleep(800)
    await rec.click(page.getByRole('button', { name: 'Modules', exact: true }))
    await sleep(500)
    zoom(800, 360, 1.5)
    const c = await rec.center(toggle(page, 'Home'))
    await rec.glide(c.x - 200, c.y + 60, 700)
    await at(3.0)
  },
  async off({ rec, page, unzoom, sleep, at }) {
    for (const name of OFF) {
      await rec.click(toggle(page, name))
      await sleep(550)
    }
    await sleep(300)
    unzoom()
    await at(7.0)
  },
  async bare({ rec, page, unzoom, sleep, at }) {
    unzoom()
    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    await sleep(900)
    await rec.glide(900, 400, 800)
    await at(4.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
