// Project hubs: the Lisbon Trip page gathers its tasks, notes, files and events. A link pasted into
// its capture bar becomes a note (titled from the page) filed with the project.
import { closeOtherTabs, expandSection, open, settle } from '../../engine/kit.mjs'

const LINK = 'https://en.wikipedia.org/wiki/Pena_Palace'
const project = (page) => page.getByRole('button', { name: 'Lisbon Trip', exact: true }).first()

/** Off camera: the event's popover has a project picker that links it at once. */
async function eventToProject(page, name) {
  const chip = page.getByRole('button', { name }).first()
  if (!(await chip.count())) {
    await page.getByRole('button', { name: 'Next period' }).click()
    await page.waitForTimeout(900)
  }
  await chip.click()
  await page.waitForTimeout(800)
  await page.getByRole('combobox').filter({ hasText: 'No project' }).first().click()
  await page.waitForTimeout(500)
  await page
    .getByRole('option', { name: /Lisbon Trip/ })
    .first()
    .click()
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

/** Off camera: a file's actions menu has "Add to project". */
async function fileToProject(page, title) {
  await open(page, title)
  await page.locator('button[title="File actions"]').first().click()
  await page.waitForTimeout(500)
  await page.getByRole('menuitem', { name: 'Add to project' }).click()
  await page.waitForTimeout(700)
  await page.getByRole('dialog').getByText('Lisbon Trip').first().click()
  await page.waitForTimeout(800)
}

export async function setup({ page }) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Month', exact: true }).click()
  await page.waitForTimeout(800)
  await eventToProject(page, /^Flight to Lisbon/)
  await eventToProject(page, /^Lisbon\s*All day/)
  await fileToProject(page, 'Flight confirmation')
  await fileToProject(page, 'Apartment booking')
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click()
  await page.waitForTimeout(900)
  await closeOtherTabs(page, 'Tasks')
  await expandSection(page, 'Projects')
  await settle(page)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const p = await rec.center(project(page))
    await rec.glide(p.x + 40, p.y + 40, 1700)
  },
  async open({ rec, page, zoom, sleep }) {
    await rec.click(project(page), { dx: -20 })
    await sleep(500)
    // The hub runs from x 308 to 1280 beside the day panel; 1.6 fits its whole width.
    zoom(794, 250, 1.6)
    await sleep(600)
    const late = await rec.center(page.getByText('Renew passport', { exact: true }).last())
    await rec.glide(late.x + 260, late.y + 4, 900)
  },
  async tour({ rec, page, zoom, sleep }) {
    zoom(794, 640, 1.6)
    await sleep(900)
    const file = await rec.center(page.getByText('Flight confirmation', { exact: true }).last())
    await rec.glide(file.x, file.y + 4, 800)
    await sleep(700)
    const event = await rec.center(page.getByText('Flight to Lisbon', { exact: true }).last())
    await rec.glide(event.x, event.y + 4, 700)
  },
  async paste({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(400)
    const bar = page.getByPlaceholder(/Add to Lisbon Trip/).first()
    await rec.click(bar, { dx: -300 })
    // The bar's text starts at x 340: frame it from its left end, and keep the pointer below it.
    zoom(720, 120, 1.8)
    await rec.glide(560, 128, 500)
    await sleep(400)
    rec.mark('paste')
    await page.keyboard.insertText(LINK)
    await sleep(900)
    await rec.key('Enter')
  },
  async filed({ rec, page, zoom, sleep }) {
    const note = page.getByText('Pena Palace - Wikipedia', { exact: true }).last()
    await note.waitFor({ timeout: 10000 })
    zoom(794, 430, 1.6)
    await sleep(500)
    const n = await rec.center(note)
    await rec.glide(n.x + 30, n.y + 4, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'Hub holds 4 notes (the link among them), 2 files, 2 events',
    (q) => {
      const rows =
        q(`SELECT l.item_type AS type, count(*) AS n FROM project_links l JOIN projects p ON p.id = l.project_id
        WHERE p.name = 'Lisbon Trip' GROUP BY l.item_type ORDER BY l.item_type`)
      const got = Object.fromEntries(rows.map((r) => [r.type, r.n]))
      if (got.note !== 4 || got.file !== 2 || got.calendar_event !== 2) return JSON.stringify(rows)
    }
  ]
]
