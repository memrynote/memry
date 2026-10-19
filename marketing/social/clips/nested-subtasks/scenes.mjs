// Subtasks inside subtasks: on "Finalize homepage hero", the hover + under "Write headline options"
// opens a draft one level further down, Tab in the next draft nests it a level deeper again, and the
// setting that allows it (Settings → Modules → Tasks → Subtasks inside subtasks) is shown on.

const PARENT = 'Finalize homepage hero'
const MID = 'Write headline options'

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Expand subtasks' }).first().click()
  await page.waitForTimeout(800)
  await page.mouse.move(1000, 700)
}

/** Hovers a task row and presses its + (the row's own "Add subtask"), like a person would. */
async function plusOn(rec, page, title) {
  const b = await row(page, title).boundingBox()
  await rec.glide(b.x + 400, b.y + b.height / 2, 500)
  await page.waitForTimeout(250)
  const plus = await page.getByTestId('add-subtask-button').evaluateAll(
    (els, y) => {
      const r = els
        .map((e) => e.getBoundingClientRect())
        .find((r) => r.width && Math.abs(r.y + r.height / 2 - y) < 8)
      return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    },
    b.y + b.height / 2
  )
  await rec.glide(plus.x, plus.y, 400)
  rec.mark('click')
  await page.mouse.click(plus.x, plus.y)
}

const row = (page, title) => page.getByText(title, { exact: true }).first()

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const p = await row(page, PARENT).boundingBox()
    await rec.glide(p.x + 160, p.y + 12, 1100)
    const m = await row(page, MID).boundingBox()
    await rec.glide(m.x + 120, m.y + 10, 1100)
  },
  async add({ rec, page, zoom, sleep, at }) {
    const m = await row(page, MID).boundingBox()
    zoom(m.x + 260, m.y + 40, 1.7)
    await sleep(300)
    await plusOn(rec, page, MID)
    await page.getByPlaceholder('Subtask title').waitFor()
    await sleep(400)
    await rec.type('Draft three variants', { cps: 12 })
    await sleep(300)
    await rec.key('Enter')
    await sleep(300)
    await rec.key('Escape')
    await at(5.0)
  },
  async deeper({ rec, page, sleep, at }) {
    await plusOn(rec, page, 'Draft three variants')
    await page.getByPlaceholder('Subtask title').waitFor()
    await sleep(400)
    await rec.type('Pick the sharpest one', { cps: 12 })
    await sleep(500)
    await rec.key('Enter')
    await sleep(500)
    await rec.key('Escape')
    await at(5.0)
  },
  async setting({ rec, page, unzoom, zoom, sleep, at }) {
    unzoom()
    const press = async (locator, dx = 20, dy = 10) => {
      const b = await locator.boundingBox()
      await rec.glide(b.x + dx, b.y + dy, 600)
      rec.mark('click')
      await page.mouse.click(b.x + dx, b.y + dy)
    }
    await press(page.getByRole('button', { name: 'Settings', exact: true }), 18, 18)
    await page.getByRole('button', { name: 'Modules' }).waitFor()
    await sleep(300)
    await press(page.getByRole('button', { name: 'Modules' }))
    const t = page.getByText('To-dos and due dates')
    await t.waitFor()
    await sleep(500)
    await press(t, 626, 8)
    await page.getByText('Subtasks inside subtasks').waitFor()
    await sleep(400)
    const c = await rec.center(page.getByText('Subtasks inside subtasks'))
    zoom(c.x + 200, c.y, 1.8)
    await rec.glide(c.x + 420, c.y, 700)
    await at(5.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
