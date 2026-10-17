// Live canvas cards: the Studio North board on the left, Hero copy options open on the right. A
// line typed into the note shows up on its card; an arrow drawn from the Moodboard card to the Hero
// card turns into a backlink in the note ("Connected on Studio North board").
import { closeOtherTabs, hideDayPanel, hideSidebar, openNote } from '../graph-edit/ui.mjs'

const BOARD = 'Studio North board'
const NOTE = 'Hero copy options'
const card = (page, title) =>
  page.locator('[data-canvas-card-state]').filter({ hasText: new RegExp(`^${title}`) })
const lastItem = (page) =>
  page
    .locator('[contenteditable=true] [data-content-type]')
    .filter({ hasText: /^Libraries, schools and a ferry terminal$/ })
const textEnd = (locator) =>
  locator.evaluate((el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    const rect = r.getBoundingClientRect()
    return { x: rect.right, y: rect.top + rect.height / 2 }
  })

export async function setup({ page }) {
  await hideDayPanel(page)
  const section = page.getByRole('button', { name: /^Canvases section, collapsed/ })
  if (await section.count()) {
    await section.first().click()
    await page.waitForTimeout(500)
  }
  await page.getByText(BOARD, { exact: true }).first().click()
  await page.waitForTimeout(2000)
  await closeOtherTabs(page, BOARD)
  await hideSidebar(page)
  // Split, then the right pane gets the note instead of a second board.
  await page.keyboard.press('Meta+\\')
  await page.waitForTimeout(1200)
  const panes = page.getByRole('tablist', { name: 'Open tabs' })
  await panes.nth(1).getByRole('tab', { name: BOARD }).click()
  await page.waitForTimeout(300)
  await openNote(page, NOTE)
  await panes.nth(1).getByRole('tab', { name: BOARD }).click()
  await page.waitForTimeout(300)
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(800)
  // Off camera: the suggested-tags row (local AI) is not this clip's subject.
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.first().click()
  // The board was framed for the full window before the split: pan it so the Hero card sits by the
  // divider, next to the note it shows. Wheel over empty board pans it.
  const pane = await page.locator('.excalidraw').first().boundingBox()
  for (let i = 0; i < 4; i++) {
    const hero = await card(page, NOTE).boundingBox()
    const dx = hero.x + hero.width - (pane.x + pane.width - 36)
    const dy = hero.y - (pane.y + 150)
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) break
    const home = await card(page, 'Homepage Ideas').boundingBox()
    await page.mouse.move(home.x + home.width + 60, home.y + home.height + 50)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(400)
  }
  await page.mouse.move(700, 800)
  await page.waitForTimeout(800)
}

export const scenes = {
  async hook({ rec, page, at }) {
    const t = await textEnd(lastItem(page))
    await at(0.5)
    await rec.glide(t.x - 60, t.y + 120, 1500)
    await at(2.4)
    await rec.glide(t.x + 30, t.y + 30, 500)
  },
  async edit({ rec, page, zoom, sleep, at }) {
    const t = await textEnd(lastItem(page))
    const c = await card(page, NOTE).boundingBox()
    zoom((c.x + t.x) / 2 + 40, (c.y + t.y) / 2 + 60, 1.5)
    await sleep(450)
    await rec.glide(t.x + 10, t.y, 400)
    rec.mark('click')
    await page.mouse.click(t.x + 10, t.y)
    await sleep(250)
    await rec.key('Enter')
    await sleep(250)
    await rec.type('Built for the people inside', { cps: 13 })
    await sleep(300)
    // Over to the card: the new line is there.
    await rec.glide(c.x + c.width - 40, c.y + c.height - 30, 900)
    await page.waitForFunction(
      (title) =>
        [...document.querySelectorAll('[data-canvas-card-state]')].some(
          (e) => e.textContent.startsWith(title) && e.textContent.includes('people inside')
        ),
      NOTE,
      { timeout: 5000 }
    )
    await at(6.4)
  },
  async arrow({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(300)
    // Moodboard sits under the Hero card, clear of the style panel the arrow tool opens on the left.
    const from = await card(page, 'Moodboard').boundingBox()
    const to = await card(page, NOTE).boundingBox()
    zoom(to.x + to.width / 2 - 60, (to.y + from.y + from.height) / 2 + 40, 1.5)
    await rec.click(page.locator('label[title^="Arrow"]'))
    await sleep(400)
    const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
    const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
    await rec.glide(a.x, a.y, 500)
    await sleep(200)
    rec.mark('click')
    await page.mouse.down()
    await rec.glide(b.x, b.y, 1100)
    await sleep(200)
    await page.mouse.up()
    await sleep(450)
    // Deselect with a click on empty board, so the arrow's style panel does not cover the cards.
    const empty = { x: to.x - 60, y: (to.y + to.height + from.y) / 2 }
    await rec.glide(empty.x, empty.y, 450)
    rec.mark('click')
    await page.mouse.click(empty.x, empty.y)
    await at(4.8)
  },
  async backlink({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(300)
    const back = page.locator('section[aria-label="Backlinks"]:visible')
    await back.waitFor({ timeout: 5000 })
    // Up the note a little, so the backlinks sit mid-screen under the zoom.
    await rec.glide(1250, 520, 400)
    for (let i = 0; i < 8; i++) {
      const left = (await back.boundingBox()).y - 330
      if (left < 12) break
      await page.mouse.wheel(0, Math.min(90, left))
      await sleep(30)
    }
    await sleep(250)
    const b = await back.boundingBox()
    zoom(b.x + 210, b.y + b.height / 2 + 40, 2.0)
    await sleep(450)
    await rec.glide(b.x + 300, b.y + b.height - 4, 800)
    await at(4.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the arrow is indexed as a link',
    (q) => (q('SELECT * FROM canvas_entity_edges').length ? null : 'no canvas edge')
  ]
]
