// Note -> task -> calendar: in the weekly sync note, `[ ]` turns a new line into a task, `@today`
// puts it in today's all-day row of the Day view beside the note, it is dragged to 1 PM, and the
// note's own task line shows the time, because both panes show the same task.
import { day } from '../../vault/cli.mjs'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const NOTE = 'Weekly sync with Sam'
const TITLE = 'Export hero assets for Sam'
const lastLine = (page) => page.getByText('approved for build')
const chip = (page) => page.getByTestId('draggable-task-chip')

// A straight, eased move with the button held. rec.glide arcs upward first, and dnd-kit reads an
// upward move as intent to scroll up: near the top of the grid it scrolls the morning into view.
async function line({ rec, page, sleep }, x1, y1, ms) {
  const { x: x0, y: y0 } = rec.mouse
  const start = Date.now()
  for (let k = 0; k < 1;) {
    k = Math.min(1, (Date.now() - start) / ms)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    await page.mouse.move(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e)
    if (k < 1) await sleep(8)
  }
  rec.mouse = { x: x1, y: y1 }
}

export async function setup({ page }) {
  // The one-time "Checkbox turned into a task" hint would cover the note on camera.
  await page.evaluate(() => localStorage.setItem('memry_checkbox_task_hint_seen', '1'))
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  // Sidebar away, then the note on the left and today's Day view on the right.
  await page.getByRole('button', { name: 'Toggle Sidebar' }).last().click()
  await page.waitForTimeout(500)
  await page.mouse.move(800, 600)
  await page.keyboard.press('Meta+\\')
  await page.waitForTimeout(1000)
  await page.getByRole('tablist', { name: 'Open tabs' }).nth(1).getByRole('tab').first().click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Day', exact: true }).first().click()
  await page.waitForTimeout(1200)
  // Day view opens the day panel; the calendar beside the note is the point, so it goes.
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.mouse.move(800, 600)
    await page.keyboard.press('Meta+Shift+B')
    await page.waitForTimeout(800)
  }
  // dnd-kit cancels pointerdown, which stops mousemove until pointerup, and the drawn cursor
  // follows mousemove: let it follow the pointer itself so it stays on the chip it drags.
  await page.evaluate(() => {
    const c = document.getElementById('__tut_cursor')
    addEventListener(
      'pointermove',
      (e) => (c.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 3}px)`),
      true
    )
  })
  await settle(page, 700, 560)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const b = await lastLine(page).boundingBox()
    await rec.glide(b.x + b.width + 40, b.y + 60, 1500)
  },
  async task({ rec, page, zoom, at, sleep }) {
    zoom(480, 360, 1.8)
    await at(0.8)
    const b = await lastLine(page).boundingBox()
    await rec.click(lastLine(page), { dx: b.width / 2 + 24 })
    await sleep(200)
    await rec.key('End')
    await rec.key('Enter')
    await sleep(350)
    await rec.type('[ ] ', { cps: 9 })
    await page.getByPlaceholder('Task name...').waitFor()
    await sleep(350)
    await rec.type(TITLE, { cps: 12 })
  },
  async today({ rec, page, zoom, at, sleep }) {
    // Wider, to hold the note's task line, today's all-day row and the 1 PM slot in one shot.
    zoom(690, 260, 1.5)
    await rec.type(' @today', { cps: 10 })
    await sleep(500)
    await rec.key('Escape')
    await chip(page).waitFor()
    await at(2.4)
    const c = await rec.center(chip(page))
    await rec.glide(c.x + 30, c.y + 26, 900)
  },
  async drag(ctx) {
    const { rec, page, at, sleep } = ctx
    await at(0.6)
    const c = await chip(page).boundingBox()
    const gx = c.x + 50
    const gy = c.y + c.height / 2
    await rec.glide(gx, gy, 600)
    await sleep(250)
    rec.mark('click')
    await page.mouse.down()
    await line(ctx, gx + 6, gy + 26, 220)
    await sleep(120)
    // The drop time comes from the chip's top edge over the day column: put that edge on the 1 PM
    // line. dnd-kit's rect for the column sits 12 px below this box (two takes landed at 12:45).
    const col = await page.getByTestId('day-time-grid').locator('[data-drop-date]').boundingBox()
    const ty = col.y + 13 * 48 + (gy - c.y) + 12
    await line(ctx, 1010, ty, 1300)
    await sleep(300)
    await page.mouse.up()
    await sleep(400)
    await rec.glide(1150, ty - 50, 600)
  },
  async same({ rec, page, zoom, at }) {
    const dates = page.getByRole('group', { name: TITLE }).getByRole('button', { name: /^Dates:/ })
    const d = await rec.center(dates)
    zoom(425, d.y, 2.0)
    await at(0.5)
    await rec.glide(d.x + 10, d.y + 30, 1000)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the task from the note is due today at 1 PM',
    (query) => {
      const [t] = query(`SELECT due_date, due_time FROM tasks WHERE title = '${TITLE}'`)
      return t?.due_date === day(0) && t?.due_time === '13:00' ? null : `got ${JSON.stringify(t)}`
    }
  ]
]
