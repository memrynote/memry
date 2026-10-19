// A year-end review as a template: Maya's own "Year in review" (five questions and a live view of
// the books she finished this year, both made in vault.mjs) is applied to a new, empty note from
// its menu. Setup only creates and names the empty note, the way anyone starts one.
import { closeOtherTabs, settle } from '../../engine/kit.mjs'

const TITLE = 'Year in review 2026'

export async function setup({ page }) {
  await page
    .getByRole('button', { name: /^New note/ })
    .first()
    .click()
  await page.getByRole('textbox', { name: 'Rename' }).waitFor()
  await page.keyboard.type(TITLE)
  await page.keyboard.press('Enter')
  await page.getByRole('tab', { name: new RegExp(TITLE) }).waitFor()
  await page.waitForTimeout(900)
  await closeOtherTabs(page, TITLE)
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  const similar = page.getByRole('button', { name: /similar notes/i })
  if (await similar.count()) await similar.first().click()
  await settle(page)
}

const more = (page) => page.getByTestId('note-more-menu').first()

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(more(page))
    await rec.glide(c.x - 260, c.y + 180, 1000)
    await rec.glide(c.x - 4, c.y + 2, 1000)
  },
  async apply({ rec, page, zoom, sleep }) {
    zoom(1230, 230, 1.6)
    await rec.click(more(page))
    const item = page.getByRole('option', { name: 'Apply Template' })
    await item.waitFor()
    await sleep(600)
    await rec.click(item)
    await page.getByRole('button', { name: /Year in review/ }).waitFor()
  },
  async pick({ rec, page, unzoom, zoom, sleep, at }) {
    unzoom()
    await sleep(500)
    const t = page.getByRole('button', { name: /Year in review/ })
    const b = await t.boundingBox()
    zoom(560, 430, 1.5)
    await rec.click(t)
    await sleep(600)
    await rec.click(page.getByRole('button', { name: 'Apply Template' }))
    await page.getByRole('heading', { name: 'What went well?' }).waitFor()
    await at(3.8)
  },
  async questions({ rec, page, zoom, sleep }) {
    const h = await page.getByRole('heading', { name: 'What went well?' }).boundingBox()
    zoom(h.x + 260, h.y + 130, 1.6)
    await sleep(500)
    await rec.glide(h.x + 360, h.y + 60, 700)
    const l = await page.getByRole('heading', { name: 'What next year?' }).boundingBox()
    await rec.glide(l.x + 330, l.y + 12, 1400)
  },
  async list({ rec, page, zoom, sleep, at }) {
    const h = await page.getByRole('heading', { name: 'Finished this year' }).boundingBox()
    zoom(h.x + 300, h.y + 100, 1.7)
    await sleep(600)
    const r = await page.getByText('Braiding Sweetgrass').boundingBox()
    await rec.glide(r.x + 420, r.y + 8, 900)
    const g = await page.getByText('Shape Up', { exact: true }).last().boundingBox()
    await rec.glide(g.x + 420, g.y + 8, 1400)
    await at(5.2)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
