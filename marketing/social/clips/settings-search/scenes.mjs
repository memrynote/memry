// Settings search: the box at the top of the Settings sidebar lists matching settings with their
// path; the first match opens and highlights, arrow keys and Enter move between matches.
import { settle } from '../../engine/kit.mjs'

const box = (page) => page.getByPlaceholder('Search settings')

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await box(page).waitFor()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  await settle(page, 900, 600)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(box(page))
    await rec.glide(c.x, c.y, 1500)
  },
  async pages({ rec, zoom, sleep, at }) {
    zoom(300, 260, 1.6)
    await rec.glide(170, 160, 700)
    await sleep(500)
    await rec.glide(170, 330, 1600)
    await at(3.8)
  },
  async font({ rec, page, zoom, sleep, at }) {
    zoom(560, 280, 1.5)
    await rec.click(box(page))
    await sleep(400)
    await rec.type('font', { cps: 9 })
    await page.getByText('3 settings').waitFor()
    await at(5.2)
  },
  async week({ rec, page, sleep, at }) {
    await rec.click(box(page))
    await rec.key('Meta+a')
    await sleep(300)
    await rec.type('week starts', { cps: 11 })
    await page.getByText('Week Starts On').last().waitFor()
    await at(5.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
