// A project for 2027: "Studio launch 2027" (vault.mjs) holds the plan note and dated steps from
// Jan 1 to Mar 3. One more step is typed into the hub's capture bar with its date, and Jan 1's
// page in the day panel shows the first step. Posted on Jan 1, recorded earlier: setup pages the
// day panel forward to January 2027 off camera, so every date on screen belongs to the new year.
// Nothing claims the device's date: the panel labels the day "Jan 1", not "Today".
import { closeOtherTabs, expandSection, settle } from '../../engine/kit.mjs'

const PROJECT = 'Studio launch 2027'
const STEP = 'Book a photographer'

const jan1 = (page) => page.getByRole('button', { name: 'Friday, January 1', exact: true })

export async function setup({ page }) {
  await expandSection(page, 'Projects')
  // The day panel's calendar on January 2027, Jan 1 picked (it opens that day's journal page).
  await page.getByRole('button', { name: 'Journal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Next month' }).waitFor()
  for (let i = 0; i < 12 && !(await jan1(page).count()); i++) {
    await page.getByRole('button', { name: 'Next month' }).click()
    await page.waitForTimeout(300)
  }
  await jan1(page).last().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: PROJECT, exact: true }).click()
  await page.getByRole('tab', { name: 'Overview' }).waitFor()
  await closeOtherTabs(page, `🌱${PROJECT}`)
  await page.getByRole('tab', { name: 'Overview' }).click()
  await page
    .getByText('JAN 1', { exact: true })
    .or(page.getByText('Jan 1', { exact: true }))
    .first()
    .waitFor()
  await settle(page, 800, 640)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.4)
    await rec.glide(900, 330, 2200)
  },
  async hub({ rec, page, zoom, at }) {
    zoom(790, 300, 1.6)
    // Down the column of dates, Jan 1 to Mar 3, and on to the plan note.
    const first = await rec.center(
      page.getByRole('button', { name: 'Open task Pick the studio name' })
    )
    await rec.glide(1180, first.y + 14, 900)
    await rec.glide(1180, first.y + 150, 1300)
    await at(4.1)
  },
  async add({ rec, page, zoom, sleep, at }) {
    zoom(790, 200, 1.6)
    await rec.click(page.getByRole('tab', { name: /^Tasks/ }), { pause: 120 })
    await page.getByRole('button', { name: 'Task: Pick the studio name' }).waitFor()
    await sleep(450)
    await rec.click(page.getByRole('textbox', { name: `Add to ${PROJECT}` }), {
      dx: -300,
      pause: 120
    })
    await sleep(300)
    // Below the bar, off the line being typed.
    await rec.glide(560, 110, 400)
    await rec.type(`${STEP} @feb 1`, { cps: 12 })
    await sleep(450)
    await rec.key('Enter')
    const row = page.getByText(STEP, { exact: true })
    await row.waitFor()
    await sleep(300)
    const c = await rec.center(row)
    await rec.glide(c.x + 260, c.y + 16, 800)
    await at(6.3)
  },
  async today({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(500)
    await rec.click(jan1(page).last(), { pause: 150 })
    await page.getByText('Friday, January 1', { exact: true }).first().waitFor()
    await sleep(700)
    const t = await rec.center(page.getByText('Pick the studio name', { exact: true }).last())
    zoom(1440, t.y - 90, 1.7)
    await rec.glide(t.x + 120, t.y + 20, 900)
    await at(5.1)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    `"${STEP}" is in ${PROJECT}, due Feb 1, 2027`,
    (query) => {
      const rows = query(
        `SELECT t.due_date FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = '${STEP}' AND p.name = '${PROJECT}'`
      )
      return rows.length === 1 && rows[0].due_date === '2027-02-01' ? null : JSON.stringify(rows)
    }
  ]
]
