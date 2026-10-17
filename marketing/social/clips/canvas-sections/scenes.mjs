// Canvas sections that file things: "Lay out by property" sorts a scattered Studio North board into
// one section per status (each section tied to its value), Hero copy options is dragged from Draft
// into the empty In review section, and the note itself now says In review.
import { closeOtherTabs, hideDayPanel, hideSidebar, vaultFile } from '../graph-edit/ui.mjs'

const BOARD = 'Studio North pipeline'
const MOVED = 'Hero copy options'
const card = (page, title) =>
  page.locator('[data-canvas-card-state]').filter({ hasText: new RegExp(`^${title}`) })
const chip = (page, value) =>
  page.locator('[data-canvas-frame-chip]').filter({ hasText: `status: ${value}` })

/**
 * Screen box of a bound section's frame. Its chip sits on the frame's top-right corner, and an empty
 * section is 360x240 scene px; the board's zoom comes from a card (260 scene px wide).
 */
async function emptyFrame(page, value) {
  const c = await chip(page, value).boundingBox()
  const zoom = (await card(page, MOVED).boundingBox()).width / 260
  return { x: c.x + c.width - 360 * zoom, y: c.y + c.height + 6, w: 360 * zoom, h: 240 * zoom }
}

/**
 * Fits the whole board in view. Shift+1 needs the board focused, so an empty spot is clicked first:
 * clicking a card would select it, and its style panel would cover the board's left (Escape keeps it).
 */
async function fit(page) {
  const boxes = await page
    .locator('[data-canvas-card-state]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
  const free = ([x, y]) =>
    boxes.every((b) => x < b.left - 20 || x > b.right + 20 || y < b.top - 20 || y > b.bottom + 20)
  const [x, y] = [
    [1300, 760],
    [1480, 180],
    [1480, 760]
  ].find(free)
  await page.mouse.click(x, y)
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(1000)
}

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
  await fit(page)
  // The first note editor of a session takes ~2.7 s to mount (a blank tab on camera); a warm one, 0.1 s.
  const c = await card(page, MOVED).boundingBox()
  await page.mouse.move(c.x + c.width - 30, c.y + 30, { steps: 4 })
  await card(page, MOVED).getByRole('button', { name: 'Open in tab' }).click()
  await page
    .locator('[contenteditable]')
    .filter({ hasText: 'Small buildings' })
    .first()
    .waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  await page.keyboard.press('Meta+w')
  await page.getByRole('tab', { name: MOVED }).waitFor({ state: 'detached' })
  await page.waitForTimeout(800)
  await fit(page)
  await page.mouse.move(820, 560)
  await page.waitForTimeout(600)
}

// Excalidraw's style panel covers the board's left edge (to x≈270) while a card is selected, so the
// drag's close-up starts right of it.
const PANEL_EDGE = 285
const DROP_ZOOM = 1.9

export const scenes = {
  async hook({ rec, page, zoom, at }) {
    zoom(830, 540, 1.25)
    // Toward the button, clicked as the hook ends (it sits in the step captions' band).
    const b = await rec.center(page.getByTestId('canvas-layout-by-property'))
    await at(0.6)
    await rec.glide(b.x - 60, b.y - 160, 1300)
    await at(2.4)
    await rec.click(page.getByTestId('canvas-layout-by-property'))
  },
  async layout({ rec, page, zoom, unzoom, sleep, at }) {
    const option = page.getByRole('option', { name: /^status/ })
    await option.waitFor()
    const o = await option.boundingBox()
    zoom(o.x + o.width / 2, o.y + 40, 1.7)
    await sleep(700)
    await rec.click(option)
    await sleep(350)
    unzoom()
    await rec.glide(800, 600, 900)
    await at(4.4)
  },
  async drop({ rec, page, zoom, sleep, at }) {
    const from = await card(page, MOVED).boundingBox()
    const frame = await emptyFrame(page, 'In review')
    const top = frame.y - 34 // the section's chip
    zoom(
      Math.max((from.x + frame.x + frame.w) / 2, PANEL_EDGE + 800 / DROP_ZOOM),
      (top + frame.y + frame.h) / 2,
      DROP_ZOOM
    )
    await sleep(600)
    // Grabbed by its title; dropped with the card centred in the empty section.
    const grab = { x: from.x + from.width / 2, y: from.y + 12 }
    const drop = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 - from.height / 2 + 12 }
    await rec.glide(grab.x, grab.y, 500)
    await sleep(200)
    rec.mark('click')
    await page.mouse.down()
    await sleep(150)
    await rec.glide(drop.x, drop.y, 1200)
    await sleep(200)
    await page.mouse.up()
    await sleep(300)
    await page.keyboard.press('Escape')
    await chip(page, 'In review').filter({ hasText: '1 card' }).waitFor()
    await rec.glide(drop.x + 60, frame.y + frame.h + 40, 600)
    await at(5.2)
  },
  async note({ rec, page, zoom, sleep, at }) {
    const c = await card(page, MOVED).boundingBox()
    await rec.glide(c.x + c.width - 40, c.y + 40, 500)
    const open = card(page, MOVED).getByRole('button', { name: 'Open in tab' })
    await open.waitFor()
    await sleep(250)
    await rec.click(open)
    const status = page.getByText('In review', { exact: true }).last()
    await status.waitFor({ state: 'visible' })
    await sleep(200)
    const s = await status.boundingBox()
    zoom(s.x + 40, s.y + 20, 1.9)
    await rec.glide(s.x + s.width + 30, s.y + s.height + 14, 800)
    await at(4.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the dropped note is In review',
    () =>
      /^status: In review$/m.test(vaultFile(`Studio North/${MOVED}.md`))
        ? null
        : 'status not written'
  ]
]
