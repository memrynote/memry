// Tasks by source: three meeting notes hold their action items as tasks (vault.mjs). Right-click
// the Meetings folder, Show Tasks lists all seven, Group by Note sorts them under their meetings,
// and a row's note chip opens the meeting the task was written in.
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const TASK = 'Outline the case study page'

/** The sidebar row named `name` (the same text shows in tabs and breadcrumbs too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

export async function setup({ page }) {
  await page.keyboard.press('Escape')
  await open(page, 'Weekly sync with Sam')
  await closeOtherTabs(page, 'Weekly sync with Sam')
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Meetings')
  await settle(page, 1000, 760)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.3)
    const m = await rec.center(await sidebarRow(page, 'Meetings'))
    await rec.glide(m.x + 90, m.y + 70, 2200)
  },
  async menu({ rec, page, zoom, sleep }) {
    const m = await rec.center(await sidebarRow(page, 'Meetings'))
    // The folder and its menu, which opens down and to the right of the click.
    zoom(300, m.y + 150, 1.8)
    await rec.glide(m.x, m.y, 500)
    await sleep(150)
    rec.mark('click')
    await page.mouse.down({ button: 'right' })
    await sleep(70)
    await page.mouse.up({ button: 'right' })
    await sleep(500)
    const item = await rec.center(page.getByRole('menuitem', { name: 'Show Tasks' }))
    await rec.glide(item.x - 20, item.y, 700)
  },
  async show({ rec, page, zoom, unzoom, sleep }) {
    await rec.click(page.getByRole('menuitem', { name: 'Show Tasks' }), { dx: -20 })
    await sleep(300)
    unzoom()
    await sleep(500)
    // The list with its "Location is Meetings" chip, the rows clear of the caption.
    zoom(794, 300, 1.5)
    await rec.glide(720, 330, 900)
  },
  async group({ rec, page, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Group by options' }))
    await sleep(500)
    await rec.click(page.getByRole('option', { name: 'Note', exact: true }))
    await sleep(450)
    await rec.key('Escape')
    await sleep(300)
    const h = await rec.center(page.getByRole('button', { name: /^Call with Jonas, 2 tasks/ }))
    await rec.glide(h.x - 250, h.y + 4, 900)
  },
  async source({ rec, page, zoom, unzoom, sleep }) {
    const row = page.getByText(TASK, { exact: true }).first()
    const r = await rec.center(row)
    await rec.glide(r.x + 300, r.y, 700)
    await sleep(350)
    await rec.click(page.getByRole('button', { name: 'Open Call with Jonas' }).first())
    await sleep(300)
    unzoom()
    await sleep(500)
    const line = page.getByText(TASK, { exact: true }).first()
    await line.waitFor()
    const l = await line.boundingBox()
    zoom(l.x + 160, l.y - 40, 1.8)
    // Past the row's project chip, so the pointer hides none of the line.
    await rec.glide(l.x + 520, l.y + 40, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
