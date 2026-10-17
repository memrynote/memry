// Search reads PDFs and screenshots: "monitor" is in neither file's name, only in the warranty
// PDF (read from its text layer) and the receipt screenshot (read by OCR, on the device). Search
// finds both; the PDF opens from the results, the screenshot from the sidebar.
import { closeOtherTabs, expandFolder, expandSection, settle } from '../../engine/kit.mjs'

const QUERY = 'monitor'
const PDF = 'document (3)'
const SHOT = 'Screenshot 2026-03-14 at 18.41'

/** The sidebar row named `name` (the same text shows in tabs and the folder view too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

export async function setup({ page }) {
  // The app reads the files' text in the background after it opens; wait until search has both.
  let found = 0
  for (let i = 0; i < 90 && found < 2; i++) {
    found = await page.evaluate(
      async (text) => (await window.api.search.query({ text })).totalCount,
      QUERY
    )
    if (found < 2) await page.waitForTimeout(1000)
  }
  if (found < 2)
    throw new Error(`Search found ${found} files for "${QUERY}"; text extraction did not finish`)

  // The day panel would squeeze the files into the left two thirds.
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Receipts')
  // Open on the Receipts folder view: two files whose names say nothing about what is in them.
  const folder = await sidebarRow(page, 'Receipts')
  await folder.hover()
  await page.waitForTimeout(300)
  const fb = await folder.boundingBox()
  const views = page.getByRole('button', { name: 'Open folder view' })
  for (let i = 0; i < (await views.count()); i++) {
    const b = await views.nth(i).boundingBox()
    if (b && Math.abs(b.y + b.height / 2 - (fb.y + fb.height / 2)) < 10) {
      await views.nth(i).click({ force: true })
      break
    }
  }
  await page.waitForTimeout(1200)
  await closeOtherTabs(page, 'Receipts')
  await settle(page)
}

const option = (page, name) =>
  page.getByRole('option', { name: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}`) })

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(page.getByRole('button', { name: 'Search or jump to…' }))
    await rec.glide(c.x + 60, c.y + 90, 1200)
    await rec.glide(c.x + 10, c.y + 12, 900)
  },
  async search({ rec, page, zoom, sleep, at }) {
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }))
    await sleep(250)
    zoom(800, 300, 1.8)
    await sleep(800)
    await rec.type(QUERY, { cps: 10 })
    await option(page, SHOT).waitFor()
    await sleep(900)
    // Passing over a result selects it: the preview names the PDF, then the image.
    const s = await rec.center(option(page, SHOT))
    await rec.glide(s.x - 30, s.y, 700)
    await at(5.0)
  },
  async pdf({ rec, page, zoom, unzoom, sleep, at }) {
    await rec.click(option(page, PDF), { dx: -30 })
    await sleep(300)
    unzoom()
    await page.getByRole('tab', { name: PDF }).waitFor()
    await page.getByText('27" 4K monitor').first().waitFor()
    await sleep(700)
    zoom(1000, 430, 1.55)
    await sleep(600)
    await rec.glide(1000, 470, 800)
    await at(5.2)
  },
  async receipt({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(500)
    await rec.click(await sidebarRow(page, SHOT))
    await page.getByRole('tab', { name: SHOT }).waitFor()
    await sleep(900)
    // The order date and the "27" 4K monitor" line.
    zoom(955, 410, 1.7)
    await sleep(600)
    await rec.glide(860, 452, 800)
    await at(6.0)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
