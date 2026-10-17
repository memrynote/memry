// Tasks where you write them: in the weekly sync's "Action items", `[ ]` starts a task, the
// `@thursday !high +website` markers become chips, the date chip is changed in place, and the
// row's arrow opens the task's details beside the note. Every camera mark is taken from the live
// layout, because the note can scroll when its similar-notes list arrives.
import { day } from '../../vault/cli.mjs'
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const NOTE = 'Weekly sync with Sam'
const TITLE = 'Send hero assets to Sam'

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  // The day panel would sit where the task's details open.
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Meetings')
  await settle(page)
}

const heading = (page) => page.getByRole('heading', { name: 'Action items' })
/** The task row: the block's own focus target, labelled with the task's title. */
const row = (page) => page.getByRole('group', { name: TITLE })

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const h = await heading(page).boundingBox()
    await rec.glide(900, h.y + 160, 1100)
    await rec.glide(h.x + h.width + 30, h.y + h.height / 2, 900)
  },
  async start({ rec, page, zoom, sleep, at }) {
    const h = await heading(page).boundingBox()
    zoom(h.x + 320, h.y + 60, 1.9)
    await sleep(600)
    // Just past the heading's last letter puts the caret at its end.
    await rec.click(heading(page), { dx: h.width / 2 + 5 })
    await sleep(350)
    await rec.key('Enter')
    await sleep(400)
    await rec.type('[ ] ', { cps: 9 })
    const name = page.getByRole('textbox', { name: 'Task name...' })
    await page.waitForFunction((el) => el === document.activeElement, await name.elementHandle())
    // Follow the line if the note moved under it.
    const n = await name.boundingBox()
    if (Math.abs(n.y - (h.y + h.height + 20)) > 20) zoom(h.x + 320, n.y + 5, 1.9)
    await sleep(400)
    await rec.type(TITLE, { cps: 12 })
    await at(5.0)
  },
  async markers({ rec, page, sleep, at }) {
    await rec.type(' @thursday !high +website', { cps: 11 })
    await sleep(800)
    await rec.key('Escape')
    await page.getByRole('button', { name: /^Dates: / }).waitFor()
    const r = await row(page).boundingBox()
    await rec.glide(r.x + 300, r.y + 70, 700)
    await at(5.4)
  },
  async chips({ rec, page, zoom, sleep, at }) {
    const chip = page.getByRole('button', { name: /^Dates: / })
    const c = await rec.center(chip)
    zoom(c.x - 40, c.y + 80, 1.8)
    await sleep(700)
    await rec.click(chip)
    await sleep(700)
    await rec.click(page.getByText('Tomorrow', { exact: true }))
    await page
      .getByRole('button', { name: /^Dates: / })
      .filter({ hasNotText: 'Oct 22' })
      .waitFor()
    await sleep(300)
    await rec.glide(c.x - 60, c.y + 60, 600)
    await at(4.8)
  },
  async details({ rec, page, zoom, sleep, at }) {
    // The row and the drawer that opens beside it, in one frame.
    const r = await row(page).boundingBox()
    zoom(1110, r.y - 120, 1.6)
    await sleep(600)
    await rec.glide(r.x + r.width - 60, r.y + r.height / 2, 600)
    await sleep(250)
    await rec.click(page.getByTitle('Open in task panel'))
    await page.getByText('Add sub-issue').waitFor()
    await sleep(700)
    await rec.glide(1440, r.y - 200, 900)
    await at(5.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the task has high priority, Website Redesign and tomorrow as its due date',
    (query) => {
      const [t] = query(
        `SELECT t.priority, t.due_date, p.name AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = '${TITLE}'`
      )
      if (!t) return 'no task'
      if (t.priority !== 3) return `priority ${t.priority}`
      if (t.project !== 'Website Redesign') return `project ${t.project}`
      if (t.due_date !== day(1)) return `due ${t.due_date}`
      return null
    }
  ]
]
