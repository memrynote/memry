// Quick capture: one typed line in the Tasks capture bar. Each marker (@date, !priority, +project,
// #tag) turns into a colored chip as it is accepted, the date chip at the bar's end follows, and
// Enter files the task in Tomorrow with all four set, as its details drawer shows.
import { expandSection, settle } from '../../engine/kit.mjs'

const TITLE = 'Send Lea the homepage draft'
const bar = (page) => page.getByPlaceholder(/Add a task/).first()
const row = (page) => page.getByText(TITLE, { exact: true }).first()

export async function setup({ page, L }) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click()
  await page.waitForTimeout(900)
  // The day panel squeezes the bar until the chips wrap onto a second line.
  if (await L('[aria-label="Resize Day Panel"]').count())
    await L('[aria-label="Day Panel"]').click()
  await expandSection(page, 'Projects')
  await settle(page)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const b = await rec.center(bar(page))
    await rec.glide(b.x - 120, b.y + 60, 1500)
  },
  async type({ rec, page, zoom, sleep }) {
    // The typed line and its chips run from x 567 to about 1005.
    zoom(800, 57, 2)
    await rec.click(bar(page), { dx: -300 })
    await sleep(200)
    // Off the line being typed, so the pointer hides no word or chip.
    await rec.glide(600, 84, 400)
    await rec.type(TITLE, { cps: 12 })
  },
  async date({ rec, sleep }) {
    await sleep(200)
    await rec.type(' @tom', { cps: 9 })
    await sleep(400)
    await rec.key('Tab')
  },
  async more({ rec, sleep }) {
    await sleep(200)
    await rec.type(' !h', { cps: 9 })
    await sleep(350)
    await rec.key('Tab')
    await sleep(450)
    await rec.type(' +webs', { cps: 10 })
    await sleep(350)
    await rec.key('Tab')
    await sleep(450)
    await rec.type(' #cli', { cps: 10 })
    await sleep(350)
    await rec.key('Tab')
  },
  async enter({ rec, page, zoom, unzoom, sleep }) {
    await sleep(300)
    await rec.key('Enter')
    await sleep(300)
    unzoom()
    await sleep(500)
    // The new row under Tomorrow, with the group header above it.
    const r = await row(page).boundingBox()
    zoom(720, r.y - 40, 1.8)
    await rec.glide(r.x + 120, r.y + r.height / 2, 800)
  },
  async open({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await rec.click(row(page), { dx: -60 })
    await sleep(500)
    // The drawer's properties: status, priority, dates, repeat, reminder, project, tags.
    zoom(1300, 215, 2)
    const tag = await rec.center(page.getByText('client', { exact: true }).last())
    await rec.glide(tag.x + 34, tag.y + 6, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'Every marker parsed',
    (q) => {
      const [t] = q(`SELECT t.due_date, t.priority, p.name AS project,
      (SELECT group_concat(tag) FROM task_tags WHERE task_id = t.id) AS tags
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = '${TITLE}'`)
      if (!t) return `task "${TITLE}" missing (title kept a marker?)`
      if (
        t.project !== 'Website Redesign' ||
        t.priority !== 3 ||
        t.tags !== 'client' ||
        !t.due_date
      )
        return JSON.stringify(t)
    }
  ]
]
