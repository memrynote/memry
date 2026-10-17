// Repeating tasks in plain English: "Water the plants every 2 weeks" typed into the Tasks capture
// bar becomes a task that repeats every 2 weeks, and finishing this month's rent puts next
// month's on the list, due the same day of the month. All in the base vault's Home project.
import { closeOtherTabs, settle } from '../../engine/kit.mjs'

const PLANTS = 'Water the plants'
const bar = (page) => page.getByRole('textbox', { name: 'Quick add task' })
const row = (page, title) => page.getByRole('button', { name: `Task: ${title}`, exact: true })
const repeatIcon = (page, title) => row(page, title).locator('[aria-label^="Repeating:"]')

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.waitForTimeout(1200)
  // Scope the list to the Home project: its four tasks fit on one screen.
  await page.getByRole('combobox', { name: 'Select project' }).click()
  await page.waitForTimeout(600)
  await page.getByRole('option', { name: /Home$/ }).click({ force: true })
  await page.waitForTimeout(1000)
  await closeOtherTabs(page, 'Tasks')
  await settle(page, 800, 640)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(bar(page))
    await rec.glide(c.x - 120, c.y + 120, 1100)
    await rec.glide(c.x - 190, c.y + 2, 900)
  },
  async type({ rec, page, zoom, sleep, at }) {
    // One frame for the whole clip: the capture bar on top, the Home list under it.
    zoom(800, 300, 1.7)
    await sleep(500)
    await rec.click(bar(page), { dx: -190 })
    await sleep(450)
    await rec.type(`${PLANTS} every 2 weeks`, { cps: 12 })
    await at(5.6)
  },
  async save({ rec, page, sleep, at }) {
    await rec.key('Enter')
    await row(page, PLANTS).waitFor()
    await sleep(600)
    // Hovering the repeat icon names the cadence the phrase became.
    const c = await rec.center(repeatIcon(page, PLANTS))
    await rec.glide(c.x - 40, c.y + 10, 600)
    await rec.glide(c.x, c.y, 300)
    await at(4.0)
  },
  async paid({ rec, page, sleep, at }) {
    const status = row(page, 'Pay rent').getByRole('button', { name: /^Status:/ })
    const s = await rec.center(status)
    await rec.glide(s.x + 40, s.y + 6, 800)
    await sleep(300)
    await rec.click(status)
    const done = page.getByRole('option', { name: 'Done' })
    await done.waitFor()
    await sleep(450)
    await rec.click(done)
    await at(4.8)
  },
  async next({ rec, page, sleep, at }) {
    // The paid rent, struck through under Done, and next month's under Later.
    await rec.click(page.getByRole('button', { name: /^Done, 1 tasks/ }), { dx: -420 })
    await sleep(600)
    const c = await rec.center(repeatIcon(page, 'Pay rent'))
    await rec.glide(c.x - 40, c.y + 10, 600)
    await rec.glide(c.x, c.y, 300)
    await at(4.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

const one = (q, sql) => q(sql)[0] ?? null
export const checks = [
  [
    `"${PLANTS}" repeats every 2 weeks`,
    (q) => {
      const t = one(
        q,
        `SELECT repeat_config FROM tasks WHERE title = '${PLANTS}' AND completed_at IS NULL`
      )
      const r = t && JSON.parse(t.repeat_config)
      return r?.frequency === 'weekly' && r?.interval === 2
        ? null
        : `repeat_config is ${t?.repeat_config}`
    }
  ],
  [
    'next rent is due a month after the paid one',
    (q) => {
      const paid = one(
        q,
        `SELECT due_date FROM tasks WHERE title = 'Pay rent' AND completed_at IS NOT NULL`
      )
      const next = one(
        q,
        `SELECT due_date FROM tasks WHERE title = 'Pay rent' AND completed_at IS NULL`
      )
      if (!paid || !next) return `paid ${paid?.due_date}, next ${next?.due_date}`
      const a = new Date(`${paid.due_date.slice(0, 10)}T12:00:00`)
      a.setMonth(a.getMonth() + 1)
      return a.toISOString().slice(0, 10) === next.due_date.slice(0, 10)
        ? null
        : `paid ${paid.due_date}, next ${next.due_date}`
    }
  ]
]
