// Backlinks that wait: in Homepage Ideas, Maya links "Photo shoot plan", a note nobody has written
// yet (the sync with Sam names it too). The note's links sections list what links in and out, the
// new link marked "Not created yet". Then she writes the note from New note, and its backlinks are
// already there: Homepage Ideas and the sync with Sam.
import { expandSection } from '../../engine/kit.mjs'
import { openAlone } from '../graph-edit/ui.mjs'

const NEW = 'Photo shoot plan'
const lastItem = (page) =>
  page
    .locator('[contenteditable=true] [data-content-type]')
    .filter({ hasText: /^Write the case study intro$/ })
    .last()
const visible = (page, label) => page.locator(`section[aria-label="${label}"]:visible`)
const newNote = (page) => page.getByRole('button', { name: /new note/i }).filter({ hasText: '⌘' })

/** Viewport point just past the end of an element's text. */
const textEnd = (page, locator) =>
  locator.evaluate((el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    const rect = r.getBoundingClientRect()
    return { x: rect.right, y: rect.top + rect.height / 2 }
  })

/** Wheel-scroll quickly (a flick, not a crawl) until `locator`'s top is at `top`. */
async function flick({ rec, page, sleep }, locator, top, { x = 1000, y = 560 } = {}) {
  await rec.glide(x, y, 300)
  for (let i = 0; i < 3; i++) {
    const left = (await locator.boundingBox()).y - top
    if (Math.abs(left) < 10) break
    const steps = Math.max(1, Math.round(Math.abs(left) / 90))
    for (let k = 0; k < steps; k++) {
      await page.mouse.wheel(0, left / steps)
      await sleep(22)
    }
    await sleep(200)
  }
  return locator.boundingBox()
}

export async function setup({ page }) {
  await openAlone(page, 'Homepage Ideas')
  await expandSection(page, 'Collections')
  // The list near the top (as far as the note scrolls), so the typing and the links below it fit
  // one zoomed frame each.
  await page.mouse.move(1000, 560)
  let last
  for (let i = 0; i < 40; i++) {
    const y = (await lastItem(page).boundingBox()).y
    if (Math.abs(y - 185) < 6 || y === last) break
    last = y
    await page.mouse.wheel(0, Math.sign(y - 185) * Math.min(60, Math.abs(y - 185)))
    await page.waitForTimeout(80)
  }
  await page.mouse.move(980, 700)
  await page.waitForTimeout(800)
}

export const scenes = {
  async hook({ rec, page, at }) {
    const t = await textEnd(page, lastItem(page))
    await at(0.5)
    await rec.glide(t.x + 160, t.y + 140, 1500)
    await at(2.4)
    await rec.glide(t.x + 50, t.y + 40, 500)
  },
  async type({ rec, page, zoom, sleep, at }) {
    const t = await textEnd(page, lastItem(page))
    zoom(t.x + 110, t.y + 75, 1.8)
    await sleep(450)
    await rec.glide(t.x + 10, t.y, 350)
    rec.mark('click')
    // A click past the end of the line puts the caret there. (No End key: on macOS it scrolls.)
    await page.mouse.click(t.x + 10, t.y)
    await sleep(250)
    await rec.key('Enter')
    await sleep(250)
    await rec.type('[[Photo shoot plan', { cps: 13 })
    await sleep(300)
    await rec.type(']] next week', { cps: 14 })
    await sleep(300)
    // The dashed link: hovering it says the note is not there yet.
    const chip = page.locator('span.wiki-link:visible', { hasText: NEW })
    const c = await rec.center(chip)
    await rec.glide(c.x - 20, c.y + 3, 400)
    await page
      .locator('[data-wiki-link-preview]')
      .waitFor({ timeout: 3000 })
      .catch(() => console.log('  no hover card'))
    console.log(`  hover card at ${rec.now().toFixed(1)}s`)
    await at(6.6)
  },
  async links(ctx) {
    const { rec, page, zoom, unzoom, sleep, at } = ctx
    unzoom()
    await sleep(350)
    const b = await flick(ctx, visible(page, 'Backlinks'), 150)
    const o = await visible(page, 'Outgoing links').boundingBox()
    zoom(b.x + b.width / 2, (b.y + o.y + o.height) / 2 + 45, 1.9)
    await sleep(500)
    // Point at the waiting link.
    const w = await rec.center(visible(page, 'Outgoing links').getByText('Not created yet'))
    await rec.glide(w.x + 50, w.y + 4, 800)
    await at(4.6)
  },
  async create({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(200)
    zoom(600, 300, 1.5)
    await rec.click(newNote(page))
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Rename'
    )
    await sleep(300)
    await rec.type(NEW, { cps: 13 })
    await sleep(250)
    await rec.key('Enter')
    const body = page.locator('[contenteditable=true]:visible').first()
    await page.getByRole('tab', { name: NEW }).waitFor()
    await sleep(500)
    const e = await body.boundingBox()
    await rec.glide(e.x + 90, e.y + e.height / 2, 450)
    rec.mark('click')
    await page.mouse.click(e.x + 90, e.y + e.height / 2)
    await sleep(200)
    await rec.type('Golden hour shots', { cps: 13 })
    await at(5.6)
  },
  async back({ rec, page, zoom, sleep, at }) {
    const b = visible(page, 'Backlinks')
    await b.waitFor({ timeout: 4000 })
    await page
      .waitForFunction(
        () =>
          /2 notes/.test(
            document.querySelector('section[aria-label="Backlinks"]')?.textContent ?? ''
          ),
        null,
        { timeout: 4000 }
      )
      .catch(() => {})
    const box = await b.boundingBox()
    zoom(box.x + box.width / 2 - 10, box.y + box.height / 2 + 30, 1.75)
    await sleep(400)
    await rec.glide(box.x + box.width - 120, box.y + box.height - 10, 900)
    await at(4.2)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'Photo shoot plan was created',
    (q) => (q(`SELECT id FROM note_metadata WHERE title = '${NEW}'`).length ? null : 'not created')
  ]
]
