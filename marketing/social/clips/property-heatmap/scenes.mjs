// A year of journal days as one picture: /chart in a note, the journal's `sleep` property, then
// the last 365 days as a calendar heatmap and as a line. The year is vault.mjs's: short nights in
// deadline weeks, long ones over the holidays, and August, when she stopped writing.
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const NOTE = '2026 in numbers'
const INTRO = 'How the year went, straight from the journal.'

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  // The day panel has nothing to do with this clip; the chart gets the window's full width.
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  await settle(page, 1000, 640)
}

const settings = (page) => page.getByRole('button', { name: 'Chart settings' })

/** In the chart settings (opened first unless they are up), a chart type, then the last 365 days. */
async function yearOf({ rec, page, sleep, zoom }, type) {
  zoom(760, 500, 1.6)
  if (!(await page.getByRole('radiogroup', { name: 'Chart' }).count())) {
    await rec.click(settings(page))
    await sleep(450)
  }
  await rec.click(page.getByRole('radio', { name: new RegExp(type) }))
  await sleep(450)
  // A new chart type starts on its own default range, so the year is picked after it.
  await rec.click(page.getByRole('button', { name: /^Last \d+ days$/ }).last())
  await sleep(400)
  await rec.click(page.getByRole('menuitemradio', { name: 'Last 365 days' }))
  await sleep(350)
  await rec.key('Escape')
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const b = await page.getByText(INTRO).boundingBox()
    await rec.glide(b.x + b.width + 40, b.y + b.height / 2, 1600)
  },
  async chart({ rec, page, zoom, sleep }) {
    zoom(700, 360, 1.6)
    await sleep(500)
    const b = await page.getByText(INTRO).boundingBox()
    await rec.click(page.getByText(INTRO), { dx: b.width / 2 + 40 })
    await sleep(200)
    await rec.key('End')
    await rec.key('Enter')
    await sleep(250)
    await rec.type('/chart', { cps: 10 })
    await sleep(700)
    await rec.key('Enter')
    await page.getByRole('option', { name: /sleep/ }).waitFor()
  },
  async property({ rec, page, sleep }) {
    await sleep(350)
    await rec.click(page.getByRole('option', { name: /sleep/ }))
    await sleep(400)
    // Off the popover, so the month of sleep drawn behind it shows.
    await rec.glide(1150, 560, 700)
  },
  async heatmap(ctx) {
    const { rec, page, zoom, at } = ctx
    await yearOf(ctx, 'Heatmap')
    const b = await page.getByRole('img', { name: /sleep over the last 365 days/ }).boundingBox()
    zoom(b.x + b.width / 2, b.y + b.height / 2 - 25, 1.5)
    await rec.glide(b.x + b.width * 0.78, b.y + b.height + 60, 900)
    await at(7.4)
  },
  async line(ctx) {
    const { rec, page, zoom, at } = ctx
    await yearOf(ctx, 'Line')
    const b = await page.getByRole('img', { name: /sleep over the last 365 days/ }).boundingBox()
    zoom(b.x + b.width / 2, b.y + b.height / 2 - 25, 1.5)
    await rec.glide(b.x + b.width * 0.62, b.y + b.height + 50, 900)
    await at(6.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
