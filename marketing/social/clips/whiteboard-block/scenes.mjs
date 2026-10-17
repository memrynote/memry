// A sketch inside a note: /whiteboard adds a board under Homepage Ideas' first line, the hero layout
// it describes is drawn in it (photo, two lines of copy, a button), and an existing canvas is
// embedded live with @ → Embed.
import { hideSidebar, openAlone, vaultFile } from '../graph-edit/ui.mjs'

const NOTE = 'Homepage Ideas'
const BOARD = 'Studio North board'
const paragraph = (page, text) =>
  page.locator('.bn-block-content[data-content-type=paragraph]').filter({ hasText: text })
const surface = (page, title) => page.locator(`.whiteboard-surface[aria-label="Drawing: ${title}"]`)

/** Screen point just past the last character of a block (a click there puts the caret at its end). */
const textEnd = (locator) =>
  locator.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = range.getClientRects()
    const last = rects[rects.length - 1]
    return { x: last.right + 12, y: last.top + last.height / 2 }
  })

/** Every note embedded, so the suggested-tags row (it shifts the note down) is there to dismiss. */
async function waitForEmbeddings(page) {
  let last = -1
  let stable = 0
  for (let i = 0; i < 180 && stable < 3; i++) {
    const { embeddingCount } = await page.evaluate(() => window.api.settings.getAIModelStatus())
    stable = embeddingCount > 40 && embeddingCount === last ? stable + 1 : 0
    last = embeddingCount
    await page.waitForTimeout(1000)
  }
}

export async function setup({ page }) {
  await waitForEmbeddings(page)
  await openAlone(page, NOTE)
  await hideSidebar(page)
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  await hide.waitFor({ timeout: 6000 }).catch(() => {})
  if (await hide.count()) {
    await hide.click()
    await hide.waitFor({ state: 'detached' })
  }
  await page.mouse.move(1000, 560)
  await page.waitForTimeout(800)
}

/** A click at a point (not a locator's centre), marked for the cursor's click ring. */
async function clickAt(rec, page, { x, y }, ms) {
  await rec.glide(x, y, ms)
  await new Promise((r) => setTimeout(r, 120))
  rec.mark('click')
  await page.mouse.click(x, y)
  await new Promise((r) => setTimeout(r, 120))
}

/** A drag with the real mouse while the recorder's cursor follows it. */
async function drag(rec, page, sleep, from, to, ms) {
  await rec.glide(from.x, from.y, 380)
  await page.mouse.down()
  await rec.glide(to.x, to.y, ms)
  await page.mouse.up()
  await sleep(120)
}

export const scenes = {
  async hook({ rec, page, zoom, at }) {
    const end = await textEnd(paragraph(page, 'Lead with'))
    zoom(826, 330, 1.45)
    await at(0.7)
    await rec.glide(end.x, end.y, 1300)
  },
  async insert({ rec, page, zoom, sleep, at }) {
    await clickAt(rec, page, await textEnd(paragraph(page, 'Lead with')))
    await rec.key('Enter')
    await rec.type('/whiteboard', { cps: 12 })
    const option = page.getByRole('option', { name: /Whiteboard/ })
    await option.waitFor()
    const o = await option.boundingBox()
    zoom(o.x + 200, o.y, 1.9)
    await sleep(900)
    await rec.key('Enter')
    await page.locator('[data-whiteboard-editing] label[title^="Rectangle"]').waitFor()
    await at(3.8)
  },
  async draw({ rec, page, zoom, sleep, at }) {
    const board = surface(page, `${NOTE} whiteboard`)
    const s = await board.boundingBox()
    zoom(s.x + s.width / 2, s.y + 170, 1.6)
    const p = (x, y) => ({ x: s.x + x, y: s.y + y })
    // The first tool from the toolbar (that also focuses the board), the rest by their keys.
    await rec.click(board.locator('label[title^="Rectangle"]'), { pause: 80 })
    await drag(rec, page, sleep, p(80, 100), p(330, 290), 650)
    await rec.key('Enter')
    await rec.type('photo', { cps: 12 })
    await rec.key('Escape')
    await rec.key('l')
    await drag(rec, page, sleep, p(370, 140), p(570, 140), 420)
    await rec.key('l')
    await drag(rec, page, sleep, p(370, 172), p(520, 172), 360)
    await rec.key('r')
    await drag(rec, page, sleep, p(370, 225), p(500, 285), 420)
    await rec.key('Enter')
    await rec.type('button', { cps: 12 })
    await rec.key('Escape')
    await sleep(250)
    await rec.click(page.getByRole('button', { name: 'Done' }))
    await page.locator('[data-whiteboard-editing]').waitFor({ state: 'detached' })
    await at(7.4)
  },
  async embed({ rec, page, zoom, sleep, at }) {
    // Stays close while the note scrolls: the last line comes up to y≈250, its menus open below it.
    zoom(880, 330, 1.5)
    const pulled = paragraph(page, 'Pulled from')
    // Flick the note up until the last line sits under the title bar.
    await rec.glide(1000, 560, 300)
    for (let i = 0; i < 3; i++) {
      const left = (await pulled.boundingBox()).y - 250
      if (Math.abs(left) < 10) break
      const steps = Math.max(1, Math.round(Math.abs(left) / 90))
      for (let k = 0; k < steps; k++) {
        await page.mouse.wheel(0, left / steps)
        await sleep(22)
      }
      await sleep(200)
    }
    const end = await textEnd(pulled)
    await clickAt(rec, page, end, 450)
    await rec.key('Enter')
    zoom(end.x - 60, end.y + 90, 1.9)
    await rec.type('@Studio North b', { cps: 13 })
    const option = page.getByRole('option').filter({ hasText: BOARD })
    await option.waitFor()
    await sleep(350)
    await rec.click(option, { pause: 80 })
    const embed = page.getByRole('option', { name: 'Embed' })
    await embed.waitFor()
    await sleep(450)
    await rec.click(embed)
    await surface(page, BOARD).locator('[data-canvas-card-state]').first().waitFor()
    await at(6.6)
  },
  async live({ rec, page, zoom, sleep, at }) {
    const cards = surface(page, BOARD).locator('[data-canvas-card-state]')
    const first = await cards.first().boundingBox()
    const last = await cards.last().boundingBox()
    zoom((first.x + last.x + last.width) / 2, first.y + first.height / 2 - 30, 1.85)
    await sleep(500)
    for (const i of [0, 1, 2]) {
      const c = await cards.nth(i).boundingBox()
      await rec.glide(c.x + c.width / 2, c.y + c.height / 2 + 20, 650)
      await sleep(150)
    }
    await at(3.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the note holds a whiteboard and the embedded board',
    () => {
      const blocks =
        vaultFile(`Studio North/${NOTE}.md`).match(/!\[whiteboard\]\(memry:\/\/canvas\/[^)]+\)/g) ??
        []
      return blocks.length === 2 && blocks[1].includes('canvas_studionorth_board')
        ? null
        : `blocks: ${blocks.join(' ')}`
    }
  ],
  [
    'the sketch was saved',
    () => {
      const { elements } = JSON.parse(vaultFile(`canvases/${NOTE} whiteboard.excalidraw`))
      const live = elements.filter((e) => !e.isDeleted)
      return live.length >= 6 ? null : `${live.length} elements`
    }
  ]
]
