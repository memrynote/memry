// Columns, callouts, footnotes: in "Homepage hero options" the two directions go side by side
// in columns (the slash menu offers two to five), the info callout becomes an Important one from
// the thirteen styles, and a footnote marker added to it previews its note on hover. Camera marks
// come from the live layout.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const NOTE = 'Homepage hero options'
const LEFT = 'Calm: one line'
const RIGHT = 'Bold: full bleed'

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Studio North')
  // Similar notes arrive a while after the note opens; let them land before the take.
  for (let i = 0; i < 40 && !(await page.getByText(/similar notes?$/).count()); i++)
    await page.waitForTimeout(750)
  await settle(page)
}

const intro = (page) =>
  page.getByText('Two directions for the Studio North homepage', { exact: false }).first()
const callout = (page) => page.locator('[data-callout-type]').first()

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const b = await intro(page).boundingBox()
    await rec.glide(b.x + b.width - 80, b.y + 140, 1100)
    await rec.glide(b.x + b.width + 6, b.y + b.height / 2, 900)
  },
  async columns({ rec, page, zoom, sleep, at }) {
    const b = await intro(page).boundingBox()
    zoom(b.x + 330, b.y + 150, 1.7)
    await sleep(600)
    await rec.click(intro(page), { dx: b.width / 2 + 6 })
    await sleep(300)
    await rec.key('Enter')
    await sleep(300)
    await rec.type('/colum', { cps: 10 })
    await page.getByRole('option', { name: /^5 columns/ }).waitFor()
    await sleep(800)
    await rec.key('Enter')
    await page.locator('[data-node-type="column"]').nth(1).waitFor()
    await sleep(400)
    await rec.type(LEFT, { cps: 13 })
    await sleep(350)
    const right = page
      .locator('[data-node-type="column"]')
      .nth(1)
      .locator('[data-content-type="paragraph"]')
      .first()
    await rec.click(right, { dx: -120 })
    await sleep(300)
    await rec.type(RIGHT, { cps: 13 })
    await sleep(300)
    // Off the text, so the two columns read whole.
    const r = await right.boundingBox()
    await rec.glide(r.x + 40, r.y + 110, 500)
    await at(8.6)
  },
  async callout({ rec, page, zoom, sleep, at }) {
    // The type menu is 13 rows tall and reaches the caption's height, so the camera puts it at the
    // left edge of the frame, clear of the centered caption.
    const c = await callout(page).boundingBox()
    zoom(c.x + 500, c.y + 290, 1.5)
    await sleep(500)
    await rec.click(page.getByRole('button', { name: 'Change callout type' }))
    const important = page.getByRole('menuitem', { name: 'Important' })
    await important.waitFor()
    await sleep(800)
    const i = await rec.center(important)
    await rec.glide(i.x - 20, i.y, 800)
    await sleep(250)
    await rec.click(important, { dx: -20 })
    await page.locator('[data-callout-type="important"]').waitFor()
    await sleep(300)
    await rec.glide(c.x + c.width + 60, c.y + c.height + 40, 600)
    await at(5.2)
  },
  async footnote({ rec, page, zoom, sleep, at }) {
    const text = callout(page).locator('.inline-content')
    const t = await text.boundingBox()
    zoom(t.x + t.width + 60, t.y + 40, 2.0)
    await sleep(500)
    // Just past the callout's last word.
    await rec.click(text, { dx: t.width / 2 + 4 })
    await sleep(300)
    await rec.type('[^1]', { cps: 9 })
    await sleep(500)
    // The marker shows as its number once the caret leaves it.
    await rec.key('Home')
    await page.locator('.footnote-ref:not(.footnote-ref-editing)').waitFor({ state: 'attached' })
    await sleep(500)
    const ref = await page.locator('.footnote-ref').first().boundingBox()
    await rec.glide(ref.x + 3, t.y + t.height / 2 - 3, 700)
    await page.locator('[data-footnote-card]').waitFor()
    await at(5.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

/** The note as the app saved it, in the vault copy the app runs on (agent-app's state file). */
function savedNote() {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, 'Studio North', `${NOTE}.md`), 'utf8')
}

export const checks = [
  [
    'the columns are saved as a Multi-Column Markdown region',
    () => {
      const md = savedNote()
      const region =
        /--- start-multi-column:[^\n]*\n[\s\S]*?--- end-column ---[\s\S]*?--- end-multi-column/.exec(
          md
        )?.[0]
      if (!region) return `no column region in:\n${md}`
      return region.includes(LEFT) && region.includes(RIGHT)
        ? null
        : `the columns lack the typed text:\n${region}`
    }
  ],
  [
    'the callout is saved as [!important]',
    () => (savedNote().includes('> [!important]') ? null : 'no [!important] callout')
  ],
  [
    'the footnote reference is in the callout',
    () => (/serif headings\[\^1\]/.test(savedNote()) ? null : 'no [^1] after the callout text')
  ]
]
