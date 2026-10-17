// Search, rebuilt: "/" scopes the search to Notes, "mobile" lists one line per note with the
// selected one previewed beside it, "#" narrows the same query to the meeting tag without leaving
// the field, and Down + Enter opens the second meeting note where the palette was.
import { closeOtherTabs, expandFolder, expandSection, settle } from '../../engine/kit.mjs'

const searchButton = (page) => page.getByRole('button', { name: 'Search or jump to…' })
const option = (page, name) => page.getByRole('option', { name: new RegExp(`^${name}`) })

/** The sidebar row named `name` (the same text can show in tabs and widgets too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

export async function setup({ page }) {
  // The day panel would push the opened note off the palette's spot.
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  // Warm-ups, so nothing loads on camera. The first note opened in a session shows a spinner
  // while the editor loads; it is opened from the sidebar, so search keeps no recent entry.
  // The take starts on this note, and the result opened at the end reuses its tab.
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Ideas')
  await (await sidebarRow(page, 'Ideas backlog')).click()
  await page.getByRole('tab', { name: 'Ideas backlog' }).waitFor()
  await page.waitForTimeout(1500)
  await closeOtherTabs(page, 'Ideas backlog')
  // The palette fetches the tag list the first time "#" is typed in it, and keeps it.
  await searchButton(page).click()
  await page.waitForTimeout(500)
  await page.keyboard.type('#')
  await page.getByRole('option', { name: /meeting/ }).waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  await settle(page)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(searchButton(page))
    await rec.glide(c.x + 160, c.y + 170, 1100)
    await rec.glide(c.x + 6, c.y + 8, 900)
  },
  async filter({ rec, page, zoom, sleep, at }) {
    await rec.click(searchButton(page))
    // The palette (x 390-1210) and, once it closes, the opened note's title and body.
    zoom(800, 330, 1.9)
    await sleep(1000)
    await rec.type('/', { cps: 10 })
    await sleep(1100)
    // Notes is the first row: Enter puts it in the field as a chip.
    await rec.key('Enter')
    await sleep(800)
    // Deleting the "/" goes back to the query; the chip stays.
    await rec.key('Backspace')
    await at(4.8)
  },
  async results({ rec, page, sleep, at }) {
    await sleep(250)
    await rec.type('mobile', { cps: 10 })
    await option(page, 'Design Principles').waitFor()
    await at(4.5)
  },
  async tag({ rec, page, sleep, at }) {
    await rec.type(' #', { cps: 9 })
    await sleep(800)
    await rec.type('mee', { cps: 9 })
    await sleep(500)
    await rec.key('Enter')
    await option(page, 'Weekly sync with Sam').waitFor()
    await at(5.5)
  },
  async open({ rec, page, sleep, at }) {
    await rec.key('ArrowDown')
    await sleep(1400)
    await rec.key('Enter')
    await page.getByRole('tab', { name: 'Studio North Kickoff' }).waitFor()
    await at(4.3)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
