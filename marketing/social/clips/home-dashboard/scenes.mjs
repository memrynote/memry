// Home, arranged: the default board (Recently edited; Bookmarks is removed off camera, "leave out
// what you don't use") gets a Journal widget from the
// Add widget menu; it lands at the bottom, is dragged by its header up into the empty right
// column, and pulled taller from its corner until its next days (today plus three) are on screen. Widgets are react-grid-layout items: the real drag and resize.
import { closeOtherTabs, settle } from '../../engine/kit.mjs'

const header = (page) => page.locator('.widget-drag-handle').filter({ hasText: 'Journal' }).first()

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  await page.getByRole('button', { name: 'Add widget' }).waitFor()
  await closeOtherTabs(page, 'Home')
  // Off camera: the Bookmarks widget is left out, so the new Journal widget lands high on screen.
  const bm = page.locator('[data-widget-type="bookmarks"]')
  await bm.getByTestId('widget-menu').click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await page.waitForTimeout(800)
  await page.mouse.move(1000, 700)
  await page.waitForTimeout(800)
}

/** Press, glide, release. */
async function drag({ rec, page, sleep }, from, to, ms) {
  await rec.glide(from.x, from.y, 600)
  await sleep(250)
  await page.mouse.down()
  await rec.glide(to.x, to.y, ms)
  await sleep(150)
  await page.mouse.up()
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const c = await rec.center(page.getByRole('button', { name: 'Add widget' }))
    await rec.glide(c.x - 200, c.y + 60, 1200)
    await rec.glide(c.x - 20, c.y + 10, 900)
  },
  async add({ rec, page, zoom, sleep, at }) {
    const btn = page.getByRole('button', { name: 'Add widget' })
    const c = await rec.center(btn)
    zoom(c.x - 100, c.y + 150, 1.6)
    await rec.click(btn, { pause: 150 })
    await sleep(500)
    await rec.click(page.getByText('Journal', { exact: true }).last(), { pause: 150 })
    await header(page).waitFor()
    await sleep(500)
    const h = await header(page).boundingBox()
    zoom(h.x + 220, h.y + 130, 1.5)
    await rec.glide(h.x + 260, h.y + 200, 700)
    await at(4.4)
  },
  async drag(ctx) {
    const { rec, page, zoom, unzoom, sleep, at } = ctx
    unzoom()
    await sleep(500)
    const h = await header(page).boundingBox()
    const from = { x: h.x + 60, y: h.y + h.height / 2 }
    const to = { x: 1000, y: 190 }
    zoom(900, 420, 1.5)
    await drag(ctx, from, to, 1500)
    await sleep(400)
    await rec.glide(to.x + 20, to.y + 120, 600)
    await at(5.2)
  },
  async resize(ctx) {
    const { rec, page, zoom, sleep, at } = ctx
    const w = page
      .locator('.react-grid-item')
      .filter({ has: header(page) })
      .first()
    const handle = w.locator('.react-resizable-handle')
    const c = await rec.center(handle)
    zoom(c.x - 120, c.y - 150, 1.5)
    await drag(ctx, c, { x: c.x, y: c.y + 430 }, 1400)
    await sleep(500)
    // The widget is taller now; its inner list scrolls down to the next days.
    const up = page.getByText('Upcoming', { exact: true }).first()
    await rec.glide(c.x - 200, c.y - 200, 600)
    for (let i = 0; i < 12 && (await up.boundingBox()).y > 520; i++) {
      await page.mouse.wheel(0, 60)
      await sleep(60)
    }
    await sleep(300)
    const u = await up.boundingBox()
    zoom(u.x + 150, u.y + 60, 1.6)
    await rec.glide(u.x + 200, u.y + 100, 700)
    await at(5.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
