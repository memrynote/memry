// Math and Mermaid blocks: under Contrast, /equation and the WCAG contrast ratio typed as LaTeX,
// which renders as a typeset fraction; then the Process flowchart's Mermaid text gets one more
// arrow and the diagram grows a box. Both blocks re-render on every keystroke, and a half-typed
// `\ov` or `-->` is a parse error that flashes red, so each command and the arrow go in as one
// input event (a fast typist's burst), and every state on screen parses.
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const BODY = 'Body text needs at least'

export async function setup({ page }) {
  await open(page, 'Design Principles')
  await closeOtherTabs(page, 'Design Principles')
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Studio North')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  await settle(page)
}

const formula = (page) => page.getByRole('button', { name: 'Edit equation' })
const diagram = (page) => page.locator('.bn-preview-container').first()
const source = (page) => page.getByLabel('Enter diagram code')

/** One input event, paced like the keystrokes around it. */
async function burst({ page, sleep }, text) {
  await page.keyboard.insertText(text)
  await sleep(110)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const b = await page.getByText(BODY).boundingBox()
    await rec.glide(b.x + b.width + 160, b.y + 90, 1000)
    await rec.glide(b.x + b.width + 60, b.y + 16, 900)
  },
  async latex(ctx) {
    const { rec, page, zoom, sleep } = ctx
    const b = await page.getByText(BODY).boundingBox()
    zoom(800, 500, 1.6)
    // Past the end of the line, so the caret lands after the last word.
    await rec.click(page.getByText(BODY), { dx: b.width / 2 + 40 })
    await sleep(350)
    await rec.key('Enter')
    await sleep(300)
    await rec.type('/equation', { cps: 11 })
    await page.getByRole('option', { name: 'Equation' }).waitFor()
    await sleep(350)
    await rec.key('Enter')
    await sleep(500)
    await rec.click(formula(page))
    await page.getByLabel('LaTeX source').waitFor()
    // The formula above, its source below, both readable.
    const f = await formula(page).boundingBox()
    const s = await page.getByLabel('LaTeX source').boundingBox()
    zoom(f.x + 200, (f.y + s.y + s.height) / 2 + 10, 2.0)
    await rec.glide(s.x + s.width + 70, s.y + s.height + 50, 700)
    await rec.type('C = ', { cps: 11 })
    await burst(ctx, '{}')
    await rec.key('ArrowLeft')
    await rec.type('L', { cps: 11 })
    await burst(ctx, '_1')
    await rec.type(' + 0.05 ', { cps: 12 })
    await burst(ctx, '\\over')
    await rec.type(' L', { cps: 12 })
    await burst(ctx, '_2')
    await rec.type(' + 0.05', { cps: 12 })
    await rec.key('ArrowRight')
    await rec.type(' ', { cps: 12 })
    await burst(ctx, '\\ge')
    await rec.type(' 4.5', { cps: 12 })
  },
  async typeset({ rec, page, zoomOn, sleep }) {
    await sleep(200)
    await rec.key('Escape')
    await sleep(300)
    await zoomOn(formula(page), 2.0, { dx: 120, dy: 30 })
    const f = await formula(page).boundingBox()
    await rec.glide(f.x + f.width + 160, f.y + f.height + 60, 900)
  },
  async mermaid({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(500)
    await rec.click(diagram(page))
    await source(page).waitFor()
    await sleep(400)
    const d = await diagram(page).boundingBox()
    const c = await source(page).boundingBox()
    zoom(d.x + d.width / 2, (d.y + c.y + c.height) / 2, 1.8)
    await sleep(500)
    await rec.glide(c.x + c.width - 40, c.y + c.height + 30, 900)
  },
  async box(ctx) {
    const { rec, page, zoom, sleep } = ctx
    const c = await source(page).boundingBox()
    // The end of the last line, right after "Review".
    await rec.click(source(page), { dx: c.width / 2 - 6, dy: c.height / 2 - 8 })
    await sleep(400)
    await burst(ctx, ' --> B')
    await rec.type('uild', { cps: 10 })
    await sleep(600)
    await rec.click(page.locator('.bn-code-block-source-popup-ok-button'))
    await sleep(400)
    const d = await diagram(page).boundingBox()
    zoom(d.x + d.width / 2, d.y + d.height / 2 + 20, 1.9)
    await rec.glide(d.x + d.width / 2 + 80, d.y + d.height + 80, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
