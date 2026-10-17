// Off-camera helpers the week-3 clips share. Copies of kit.mjs moves with two fixes for this vault:
// search does not rank an exact title first (searching "Homepage Ideas" puts Design Principles,
// which links to it, on top), so a note is opened by clicking its own result; and only document
// tabs are closed, never the last one (Cmd+W on the last tab closes the window).
import fs from 'node:fs'
import path from 'node:path'

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Off camera: open a note by its exact title through the search box. */
export async function openNote(page, title) {
  // Cmd+K: the sidebar's search button is off screen while the sidebar is hidden.
  await page.keyboard.press('Meta+k')
  await page.getByPlaceholder('Search notes, tasks, journal, inbox…').waitFor()
  await page.waitForTimeout(300)
  await page.keyboard.type(title)
  const options = page.getByRole('option').filter({ hasText: new RegExp(`^${esc(title)}`) })
  await options.first().waitFor()
  await page.waitForTimeout(500)
  // The row reads "<title><folder>": the exact title is the row whose title element says just that.
  const n = await options.count()
  for (let i = 0; i < n; i++) {
    const texts = await options
      .nth(i)
      .locator('span, div')
      .evaluateAll((els) => els.map((e) => e.textContent.trim()))
    if (texts.includes(title)) {
      await options.nth(i).click()
      await page.waitForTimeout(1200)
      return
    }
  }
  throw new Error(`No search result titled "${title}"`)
}

const docTabs = (page) => page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')

/** Off camera: close every document tab but the one named `keep`. */
export async function closeOtherTabs(page, keep) {
  for (let i = 0; i < 12; i++) {
    const names = (await docTabs(page).allTextContents()).map((t) => t.trim())
    const other = names.findIndex((t) => t !== keep)
    if (other < 0 || names.length < 2) return
    await docTabs(page).nth(other).click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
}

/** Off camera: hide the right day panel if it is open. */
export async function hideDayPanel(page) {
  if (await page.getByRole('tablist', { name: 'Right sidebar' }).count()) {
    await page.keyboard.press('Meta+Shift+B')
    await page.waitForTimeout(600)
  }
}

/** Off camera: collapse the left sidebar if it is open. */
export async function hideSidebar(page) {
  if (
    await page
      .getByRole('button', { name: /new note/i })
      .filter({ hasText: '⌘' })
      .count()
  ) {
    await page.getByRole('button', { name: 'Toggle Sidebar' }).last().click()
    await page.waitForTimeout(600)
  }
}

/** Off camera: open a note alone in its tab, with the day panel hidden. */
export async function openAlone(page, title) {
  await openNote(page, title)
  await closeOtherTabs(page, title)
  await hideDayPanel(page)
}

/** Box of a locator as [x, y, w, h], rounded (for probing). */
export async function box(locator) {
  const b = await locator.boundingBox()
  return b && [b.x, b.y, b.width, b.height].map(Math.round)
}

/**
 * For checks: a file of the vault the take ran on (the slot's live copy, named in agent-app's state
 * file). Frontmatter properties and canvases live in the files, not in data.db.
 */
export function vaultFile(rel) {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, rel), 'utf8')
}
