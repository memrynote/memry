// Timeline view: the week calendar turns into a Gantt chart, the planned work and the trips show as
// bars, and the accessibility pass, which runs into the Lisbon trip, is dragged to after it.
import { day } from '../../vault/cli.mjs'
import { settle } from '../../engine/kit.mjs'

const view = (page, name) => page.getByRole('button', { name, exact: true })
const bar = (page, title) => page.getByTestId('timeline-task-bar').filter({ hasText: title })

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click()
  await page.waitForTimeout(1200)
  // Only the calendar tab: the vault opens on Home.
  const tab = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  for (let i = 0; i < 6; i++) {
    const tabs = await tab.evaluateAll((els) => els.map((e) => e.textContent.trim()))
    const other = tabs.findIndex((t) => !/Calendar/.test(t))
    if (other < 0) break
    await tab.nth(other).click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
  // The chart gets the whole window: no sidebar, no day panel.
  await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click()
  await page.waitForTimeout(400)
  await page.mouse.move(800, 500)
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+B')
    await page.waitForTimeout(500)
  }
  // The timeline remembers its zoom: Weeks, so a day is wide enough for the bar labels.
  await view(page, 'Timeline').click()
  await page.waitForTimeout(900)
  await page.getByRole('radio', { name: 'Weeks' }).click()
  await page.waitForTimeout(600)
  await view(page, 'Week').click()
  await page.waitForTimeout(1200)
  // A timeline drag cancels pointerdown, which stops mousemove until pointerup, and the drawn
  // cursor follows mousemove: let it follow the pointer itself so it stays on the bar it drags.
  await page.evaluate(() => {
    const c = document.getElementById('__tut_cursor')
    addEventListener(
      'pointermove',
      (e) => (c.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 3}px)`),
      true
    )
  })
  await settle(page, 760, 520)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    await rec.glide(1000, 230, 1300)
    const c = await rec.center(view(page, 'Timeline'))
    await rec.glide(c.x - 6, c.y + 40, 900)
  },
  async switch({ rec, page, zoom, at, sleep }) {
    zoom(1000, 300, 1.5)
    await at(0.9)
    await rec.click(view(page, 'Timeline'))
    await sleep(350)
    await rec.glide(760, 330, 1100)
    await bar(page, 'Accessibility pass').waitFor()
  },
  async bars({ rec, page, zoom, at }) {
    zoom(880, 400, 1.6)
    await at(0.6)
    // Down the redesign's cascade, then up to the trips above it.
    for (const title of [
      'Finalize homepage hero',
      'Draft sitemap',
      'Build style guide page',
      'Case study template'
    ]) {
      const b = await bar(page, title).boundingBox()
      await rec.glide(b.x + Math.min(90, b.width / 2), b.y + b.height / 2, 520)
    }
    const lisbon = await page
      .getByTestId('timeline-event-bar')
      .filter({ hasText: 'Lisbon' })
      .boundingBox()
    await rec.glide(lisbon.x + 70, lisbon.y + lisbon.height / 2, 900)
  },
  async drag({ rec, page, zoom, at, sleep }) {
    zoom(1180, 410, 1.7)
    await at(0.9)
    // Oct 24-27 runs into the trip; six days later it starts the day after.
    const b = await bar(page, 'Accessibility pass').boundingBox()
    const x = b.x + 100
    const y = b.y + b.height / 2
    await rec.glide(x, y, 700)
    await sleep(250)
    rec.mark('click')
    await page.mouse.down()
    await rec.glide(x + 6 * 48, y, 1300)
    await sleep(300)
    await page.mouse.up()
    await sleep(400)
    await rec.glide(x + 6 * 48 + 30, y - 70, 600)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the accessibility pass moved to after the trip',
    (query) => {
      const [t] = query("SELECT start_date, due_date FROM tasks WHERE title = 'Accessibility pass'")
      return t?.start_date === day(13) && t?.due_date === day(16)
        ? null
        : `got ${JSON.stringify(t)}`
    }
  ]
]
