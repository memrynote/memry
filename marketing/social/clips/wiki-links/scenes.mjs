// Two brackets link anything: in Lisbon prep, [[ links a note and a canvas from its suggestions, a
// journal day by its date (typed in full: the menu does not suggest days), and the trip's Budget by
// its folder path, since Studio North has a Budget too.
import { hideSidebar, openAlone, vaultFile } from '../graph-edit/ui.mjs'
import { NOTE } from './vault.mjs'

const options = (page) =>
  page.getByRole('listbox', { name: 'Note suggestions' }).getByRole('option')
const chip = (page, text) => page.locator('span.wiki-link').filter({ hasText: text })
const preview = (page) => page.locator('[data-wiki-link-preview]')

/** Screen point just past the last character of a block (a click there puts the caret at its end). */
const textEnd = (locator) =>
  locator.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = range.getClientRects()
    const last = rects[rects.length - 1]
    return { x: last.right + 12, y: last.top + last.height / 2 }
  })

export async function setup({ page }) {
  await openAlone(page, NOTE)
  await hideSidebar(page)
  // The editor settles its first sync after opening; a caret placed before that lands at the top.
  await page.waitForTimeout(2500)
  await page.mouse.move(1000, 600)
  await page.waitForTimeout(500)
}

/** Types the start of a link and picks the suggestion that reads `pick` (title, then folder). */
async function link(rec, page, sleep, text, pick, read = 450) {
  await rec.type(text, { cps: 14 })
  const option = options(page).filter({ hasText: pick }).first()
  await option.waitFor()
  await sleep(read)
  await rec.click(option, { pause: 120 })
}

export const scenes = {
  async hook({ rec, page, zoom, at }) {
    zoom(800, 420, 1.3)
    const end = await textEnd(page.locator('.bn-block-content').filter({ hasText: 'Two weeks' }))
    await at(0.8)
    await rec.glide(end.x, end.y, 1300)
  },
  async note({ rec, page, zoom, sleep, at }) {
    zoom(800, 460, 1.8)
    const end = await textEnd(page.locator('.bn-block-content').filter({ hasText: 'Two weeks' }))
    await rec.glide(end.x, end.y, 200)
    rec.mark('click')
    await page.mouse.click(end.x, end.y)
    await sleep(300)
    await rec.key('Enter')
    await link(rec, page, sleep, 'Day 2 is the [[Sint', 'Sintra day trip')
    await chip(page, 'Sintra day trip').waitFor()
    await at(4.2)
  },
  async canvas({ rec, page, sleep, at }) {
    await rec.key('Enter')
    await link(rec, page, sleep, 'All of it on the [[Lisbon b', 'Lisbon board')
    await chip(page, 'Lisbon board').waitFor()
    await at(3.8)
  },
  async day({ rec, page, sleep, at }) {
    await rec.key('Enter')
    await rec.type('Flights booked on [[2026-10-12]] ', { cps: 15 })
    const c = await chip(page, '2026-10-12').boundingBox()
    await rec.glide(c.x + c.width / 2, c.y + c.height / 2 + 2, 500)
    await preview(page).filter({ hasText: 'Booked the flights' }).waitFor()
    await at(5.4)
  },
  async folder({ rec, page, sleep, at }) {
    // Off the chip and up, away from its card (which opens below it), so the card closes.
    const day = await chip(page, '2026-10-12').boundingBox()
    await rec.glide(day.x + day.width + 220, day.y - 50, 350)
    await preview(page).waitFor({ state: 'hidden' })
    await rec.key('Enter')
    await link(rec, page, sleep, 'Money: [[Budg', 'Lisbon', 1100)
    const c = await chip(page, 'Lisbon/Budget').boundingBox()
    await sleep(300)
    await rec.glide(c.x + c.width / 2, c.y + c.height / 2 + 2, 450)
    await preview(page).filter({ hasText: 'Flights 240' }).waitFor()
    await at(5.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the links are in the markdown',
    () => {
      const md = vaultFile(`Lisbon/${NOTE}.md`)
      const missing = [
        'Two weeks to go. What is left:',
        '[[Sintra day trip]]',
        '[[Lisbon board]]',
        '[[2026-10-12]]',
        '[[Lisbon/Budget]]'
      ].filter((s) => !md.includes(s))
      return missing.length ? `missing: ${missing.join(', ')}` : null
    }
  ]
]
