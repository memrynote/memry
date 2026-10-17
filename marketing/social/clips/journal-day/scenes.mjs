// The journal: today's page, with the day's events and tasks in the day panel beside it. Maya
// writes a line about the design review she sees there, links Sam with [[, and Sam's note lists
// today among the days that mention him.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { day } from '../../vault/cli.mjs'
import { settle } from '../../engine/kit.mjs'

const firstLine = (page) => page.getByText('Client call at 3.')
const dayPanel = (page) => page.locator('[data-slot="day-panel-inner"]')
const chip = (page) => page.locator('span.wiki-link').filter({ hasText: 'Sam Okafor' })

export async function setup({ page }) {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Journal', exact: true })
    .click()
  await page.waitForTimeout(1200)
  // Only the journal tab (the Open tabs bar: the day panel has tabs of its own).
  const tab = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  for (let i = 0; i < 6; i++) {
    const tabs = await tab.evaluateAll((els) => els.map((e) => e.textContent.trim()))
    const other = tabs.findIndex((t) => t !== 'Journal')
    if (other < 0) break
    await tab.nth(other).click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
  // The page and the day panel, nothing else; the panel's edge dragged left, so its events and
  // tasks fill the shot that is about them.
  await page.getByRole('button', { name: 'Toggle Sidebar' }).last().click()
  await page.waitForTimeout(500)
  const edge = await page.getByRole('button', { name: 'Resize Day Panel' }).boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, 450)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 - 140, 450, { steps: 20 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  await settle(page, 640, 560)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(dayPanel(page).getByText('Design review with Studio North'))
    await rec.glide(c.x - 80, c.y + 40, 1600)
  },
  async day({ rec, page, zoom, at }) {
    // From just above the panel's Today header down: the caption band stays below the tasks.
    const head = await dayPanel(page)
      .getByRole('button', { name: 'Today', exact: true })
      .boundingBox()
    zoom(1600, head.y - 40 + 225, 2.0)
    await at(0.8)
    for (const text of [
      'Design review with Studio North',
      'Client review call',
      'Reply to Jonas about the workshop'
    ]) {
      const c = await rec.center(dayPanel(page).getByText(text, { exact: true }))
      await rec.glide(c.x - 40, c.y + 14, 650)
    }
  },
  async write({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(450)
    const b = await firstLine(page).boundingBox()
    zoom(b.x + 300, b.y + 110, 1.8)
    await rec.click(firstLine(page), { dx: b.width / 2 + 24 })
    await sleep(250)
    await rec.key('End')
    await rec.key('Enter')
    await sleep(300)
    await rec.type('Design review went well.', { cps: 12 })
  },
  async link({ rec, page, sleep }) {
    await sleep(250)
    await rec.key('Enter')
    await sleep(250)
    await rec.type('Lunch with ', { cps: 12 })
    await rec.type('[[', { cps: 8 })
    await sleep(250)
    await rec.type('Sam', { cps: 9 })
    await page.getByRole('option', { name: 'Sam Okafor' }).waitFor()
    await sleep(650)
    await rec.key('Enter')
    await sleep(300)
    await rec.type('after.', { cps: 12 })
    // The rest of the scene holds on the link while the page saves: backlinks read the file.
    const c = await rec.center(chip(page))
    await rec.glide(c.x + 40, c.y + 40, 700)
  },
  async remembers({ rec, page, zoom, unzoom, sleep }) {
    await rec.click(chip(page))
    const refs = page.getByText(/notes · \d+ references/)
    await refs.waitFor()
    unzoom()
    await sleep(350)
    // Sam's note is short: its backlinks sit low, so the page goes as far down as it scrolls.
    await rec.glide(700, 520, 400)
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 40)
      await sleep(40)
    }
    await sleep(300)
    const r = await refs.boundingBox()
    zoom(r.x + 230, r.y + 150, 2.0)
    const today = await rec.center(page.getByText(day(0), { exact: true }))
    await rec.glide(today.x + 60, today.y + 30, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    "today's journal file has the line and the link to Sam",
    () => {
      // Links live in the index database, which query() does not read; the page's own file is
      // the source of truth anyway. The slot's app records its vault copy in its state file.
      const { vaultPath } = JSON.parse(
        fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')
      )
      const text = fs.readFileSync(path.join(vaultPath, 'journal', `${day(0)}.md`), 'utf8')
      return /Design review went well\./.test(text) && /\[\[Sam Okafor\]\]/.test(text)
        ? null
        : `got ${JSON.stringify(text)}`
    }
  ]
]
