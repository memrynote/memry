// Start dates: a task due in two weeks gets a start date of today from the capture bar's options,
// so the Today view lists it now instead of hiding it until the deadline. Its details then show
// both dates and how far away each one is.
import { closeOtherTabs, settle } from '../../engine/kit.mjs'

const TASK = 'Write the case study'
const bar = (page) => page.getByRole('textbox', { name: 'Quick add task' })
const row = (page) => page.getByRole('button', { name: `Task: ${TASK}`, exact: true })

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('combobox', { name: 'Task views' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('option', { name: /^Today/ }).click({ force: true })
  await page.waitForTimeout(900)
  // Overdue folded away, so the list is today's work and the new task lands high on screen.
  await page.getByRole('button', { name: /^Overdue, \d+ tasks/ }).click()
  await page.waitForTimeout(600)
  await closeOtherTabs(page, 'Tasks')
  await settle(page, 800, 640)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(bar(page))
    await rec.glide(c.x - 100, c.y + 140, 1100)
    await rec.glide(c.x - 180, c.y + 2, 900)
  },
  async type({ rec, page, zoom, sleep, at }) {
    zoom(790, 250, 1.6)
    await sleep(500)
    await rec.click(bar(page), { dx: -180 })
    await sleep(450)
    await rec.type(`${TASK} @in 2 weeks`, { cps: 12 })
    await sleep(400)
    // Toward the due date the phrase became.
    const c = await rec.center(page.getByRole('button', { name: /^Due .*Change due date$/ }))
    await rec.glide(c.x, c.y + 18, 700)
    await at(5.4)
  },
  async start({ rec, page, sleep, at }) {
    await rec.click(page.getByRole('button', { name: 'Task options' }))
    const item = page.locator('[data-preset-view="startDate"]')
    await item.waitFor()
    await sleep(500)
    await rec.click(item)
    const today = page.locator('button').filter({ hasText: /^Today\s*[A-Z][a-z]{2} \d+$/ })
    await today.waitFor()
    await sleep(450)
    await rec.click(today)
    // Back on the menu, the Start date row now reads today's date, as does the chip in the bar.
    await sleep(400)
    const set = await rec.center(item)
    await rec.glide(set.x + 30, set.y + 2, 600)
    await at(5.2)
  },
  async today({ rec, page, sleep, at }) {
    await rec.key('Escape')
    await sleep(350)
    await rec.key('Enter')
    await row(page).waitFor()
    await sleep(500)
    const c = await rec.center(row(page))
    await rec.glide(c.x - 60, c.y + 2, 800)
    await at(4.4)
  },
  async drawer({ rec, page, zoom, sleep, at }) {
    await rec.click(row(page), { dx: -60 })
    await rec.glide(1000, 300, 400)
    const starts = page.locator('[title="Start date"]')
    await starts.waitFor()
    await sleep(300)
    const b = await starts.boundingBox()
    zoom(b.x + b.width / 2 - 30, b.y + 20, 2.0)
    await sleep(700)
    await rec.glide(b.x + b.width - 10, b.y + b.height / 2 + 6, 800)
    await sleep(500)
    await rec.glide(b.x + b.width - 10, b.y + b.height + 22, 600)
    await at(5.2)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    `"${TASK}" starts today and is due in 14 days`,
    (q) => {
      const t = q(`SELECT start_date, due_date FROM tasks WHERE title = '${TASK}'`)[0]
      if (!t?.start_date || !t?.due_date) return `start ${t?.start_date}, due ${t?.due_date}`
      const days = Math.round(
        (new Date(t.due_date.slice(0, 10)) - new Date(t.start_date.slice(0, 10))) / 864e5
      )
      const today = new Date()
      const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      return t.start_date.slice(0, 10) === local && days === 14
        ? null
        : `start ${t.start_date}, due ${t.due_date}`
    }
  ]
]
