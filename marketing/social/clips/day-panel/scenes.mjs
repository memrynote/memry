// The day panel: Maya's design review prep note, Cmd+Shift+B opens today's calendar and tasks
// beside it, she writes a line about the call she sees there, and the same keys close it.
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const panelOpen = (page) => page.getByRole('button', { name: 'Resize Day Panel' }).count()
const lastLine = (page) => page.getByText('Launch two weeks after sign-off?')

export async function setup({ page }) {
  await open(page, 'Design review prep')
  await closeOtherTabs(page, 'Design review prep')
  // The panel opens by default in a fresh profile; the clip starts without it.
  await page.mouse.move(800, 700)
  if (await panelOpen(page)) await page.keyboard.press('Meta+Shift+B')
  await page.waitForTimeout(600)
  await settle(page, 820, 640)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.5)
    await rec.glide(960, 600, 1400)
  },
  async open({ rec, page, zoom, at, sleep }) {
    zoom(1000, 470, 1.5)
    await at(1.0)
    await rec.key('Meta+Shift+B')
    await page.getByRole('button', { name: 'Resize Day Panel' }).waitFor()
    await sleep(500)
    await rec.glide(1180, 560, 900)
  },
  async day({ rec, page, zoom, at }) {
    // 2.0 puts the frame's left edge past the end of the note's lines: only the panel, no cut words.
    zoom(1400, 500, 2.0)
    await at(0.8)
    const review = page.getByText('Design review with Studio North').last()
    const r = await rec.center(review)
    await rec.glide(r.x - 40, r.y + 4, 800)
    await at(2.4)
    const call = await rec.center(page.getByText('Client review call', { exact: true }).last())
    await rec.glide(call.x - 10, call.y + 4, 700)
  },
  async write({ rec, page, zoom, at, sleep }) {
    zoom(1000, 470, 1.5)
    await at(0.9)
    const b = await lastLine(page).boundingBox()
    await rec.click(lastLine(page), { dx: b.width / 2 + 60 })
    await sleep(250)
    await rec.key('End')
    await rec.key('Enter')
    await sleep(300)
    await rec.type('Move the client call to Friday?', { cps: 12 })
    await sleep(300)
    await rec.glide(b.x + b.width + 260, b.y + 120, 700)
  },
  async close({ rec, page, at, sleep }) {
    await at(0.9)
    await rec.key('Meta+Shift+B')
    await page.getByRole('button', { name: 'Resize Day Panel' }).waitFor({ state: 'detached' })
    await sleep(400)
    await rec.glide(1250, 600, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
