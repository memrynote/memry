// The pitch for anyone new: Home, a note (from Home's bookmarks), Tasks, today's journal page and
// the week in the calendar, one beat each. The day panel stays open beside every page: today's
// events and tasks next to whatever is open is the "one app" idea itself. Rail clicks replace the
// page in the one tab, so the tab bar stays clean.
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const rail = (page, name) => page.getByRole('button', { name, exact: true }).first()

/** The first match left of the day panel (the panel lists today's tasks and events too). */
async function inMain(locator) {
  // The panel's copy can show before the page has rendered its own.
  for (let tries = 0; tries < 40; tries++) {
    for (let i = 0; i < (await locator.count()); i++) {
      const b = await locator.nth(i).boundingBox()
      if (b && b.x > 300 && b.x < 1240) return locator.nth(i)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`No match in the main pane for ${locator}`)
}

export async function setup({ page }) {
  // The first note a session opens loads the editor, a blank pane for seconds. Do that here.
  await open(page, 'Design Principles')
  await page.getByText('Fewer pages, more clarity').first().waitFor()
  // The calendar opens on Month; the week reads better at phone size. Set it, then go home.
  await rail(page, 'Calendar').click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.waitForTimeout(800)
  await rail(page, 'Home').click()
  await page.getByText('Website Redesign Brief', { exact: true }).last().waitFor()
  await closeOtherTabs(page, 'Home')
  if (!(await page.locator('[aria-label="Resize Day Panel"]').count())) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await settle(page, 1000, 700)
}

/** Back to the wide shot, over to the rail, click: the page swaps in the same tab. */
async function go({ rec, page, unzoom, sleep }, name) {
  unzoom()
  await sleep(250)
  await rec.click(rail(page, name))
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const b = await rec.center(page.getByText('Website Redesign Brief', { exact: true }).last())
    await rec.glide(b.x + 260, b.y + 120, 1000)
    await rec.glide(b.x + 30, b.y + 4, 800)
  },
  async note({ rec, page, zoom, sleep, at }) {
    await rec.click(page.getByText('Website Redesign Brief', { exact: true }).last())
    const title = page.getByRole('heading', { name: 'Goal' })
    await title.waitFor()
    await sleep(350)
    zoom(820, 340, 1.6)
    await sleep(700)
    const g = await title.boundingBox()
    await rec.glide(g.x + 260, g.y + 70, 900)
    await at(4.4)
  },
  async tasks(ctx) {
    const { rec, page, zoom, sleep, at } = ctx
    await go(ctx, 'Tasks')
    const today = await inMain(page.getByText('Client review call', { exact: true }))
    await sleep(350)
    zoom(800, 270, 1.6)
    await sleep(700)
    const t = await today.boundingBox()
    await rec.glide(t.x + t.width + 40, t.y + t.height / 2, 900)
    await at(4.4)
  },
  async journal(ctx) {
    const { rec, page, zoom, sleep, at } = ctx
    await go(ctx, 'Journal')
    const line = page.getByText('Client call at 3', { exact: false }).first()
    await line.waitFor()
    await sleep(350)
    const l = await line.boundingBox()
    zoom(l.x + 330, l.y + 20, 1.7)
    await sleep(700)
    await rec.glide(l.x + l.width + 30, l.y + l.height / 2 + 4, 900)
    await at(4.4)
  },
  async calendar(ctx) {
    const { rec, page, zoom, sleep, at } = ctx
    await go(ctx, 'Calendar')
    const review = await inMain(page.getByText(/^Design review/))
    await sleep(350)
    // The day names stay in frame, with today's column on the left.
    zoom(740, 380, 1.5)
    await sleep(700)
    const r = await review.boundingBox()
    await rec.glide(r.x + r.width / 2, r.y + r.height + 30, 900)
    await at(4.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
