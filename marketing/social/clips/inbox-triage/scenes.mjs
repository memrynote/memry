// Inbox triage: Maya pastes a Wikipedia link and types a thought into the capture bar, then sorts
// them: the link is filed as a note in her Lisbon folder (it shows up there in the sidebar), and
// the thought becomes a task due today (it shows up in the day panel's tasks). The link's title is
// fetched live from the page.
import { day } from '../../vault/cli.mjs'
import { expandFolder, expandSection, settle } from '../../engine/kit.mjs'

const LINK = 'https://en.wikipedia.org/wiki/Sintra'
const THOUGHT = 'Book train tickets to Sintra'
const capture = (page) => page.getByRole('textbox', { name: 'Capture input' })
const linkRow = (page) => page.getByRole('listitem', { name: /^Link: Sintra/ })
const thoughtRow = (page) => page.getByRole('listitem', { name: `Note: ${THOUGHT}` })
const panel = (page) => page.getByRole('complementary', { name: 'Item details' })

/**
 * kit.closeOtherTabs scoped to the window's tab bar: it also counts the Inbox page's own
 * Inbox / Archived / Insights tabs, and Cmd+W on those closes the window.
 */
async function closeOtherTabs(page, keep) {
  const tab = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  for (let i = 0; i < 12; i++) {
    const tabs = await tab.evaluateAll((els) => els.map((e) => e.textContent.trim()))
    const other = tabs.findIndex((t) => t !== keep)
    if (other < 0) return
    await tab.nth(other).click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
}

/** Center of the first sidebar entry (left of x 300) whose text matches, once it is there. */
async function sidebarItem(page, text) {
  for (let i = 0; i < 50; i++) {
    const items = page.getByText(text)
    for (let k = 0; k < (await items.count()); k++) {
      const b = await items.nth(k).boundingBox()
      if (b && b.x < 300) return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    await page.waitForTimeout(100)
  }
  throw new Error(`No sidebar entry ${text}`)
}

export async function setup({ page }) {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Inbox', exact: true })
    .click()
  await page.waitForTimeout(1200)
  await closeOtherTabs(page, 'Inbox')
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Lisbon')
  // A wider day panel (its edge dragged left), so today's tasks fill the last shot.
  const edge = await page.getByRole('button', { name: 'Resize Day Panel' }).boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, 450)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 - 200, 450, { steps: 20 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  // The link Maya copied while reading about the day trip.
  await page.evaluate((link) => navigator.clipboard.writeText(link), LINK)
  await settle(page, 700, 520)
}

/** Click into the capture bar and wait for its focus: after a capture the list takes it back. */
async function focusCapture({ rec, page, sleep }) {
  await rec.click(capture(page), { dx: -120 })
  await page.waitForFunction(
    (el) => el === document.activeElement,
    await capture(page).elementHandle()
  )
  await sleep(200)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(capture(page))
    await rec.glide(c.x - 150, c.y + 70, 1600)
  },
  async paste(ctx) {
    const { rec, page, zoom, at, sleep } = ctx
    zoom(640, 150, 1.6)
    await at(0.4)
    await focusCapture(ctx)
    await rec.key('Meta+v')
    await sleep(700)
    await rec.key('Enter')
    await linkRow(page).waitFor()
    await sleep(500)
    await focusCapture(ctx)
  },
  async type({ rec, page, sleep }) {
    await rec.type(THOUGHT, { cps: 13 })
    await sleep(300)
    await rec.key('Enter')
    await thoughtRow(page).waitFor()
    await sleep(300)
    await rec.glide(540, 220, 500)
  },
  async file({ rec, page, zoom, unzoom, sleep }) {
    await rec.click(linkRow(page), { dx: -120 })
    const fileTo = panel(page).getByRole('button', { name: /^File to: / })
    await fileTo.waitFor()
    await sleep(250)
    const f = await fileTo.boundingBox()
    zoom(f.x + f.width / 2, f.y + 90, 1.6)
    await sleep(450)
    // The folder it suggests (computed on the device) is Lisbon: one click. If no suggestion
    // came, the folder is picked by name.
    const suggested = panel(page).getByRole('button', { name: /^[1-5]\s*Lisbon$/ })
    if (await suggested.count()) {
      await rec.click(suggested)
      await sleep(400)
    } else if (!/Lisbon/.test(await fileTo.getAttribute('aria-label'))) {
      await rec.click(fileTo, { dx: -80 })
      await page.getByPlaceholder('Search or create with /...').waitFor()
      await sleep(250)
      await rec.type('Lis', { cps: 9 })
      const lisbon = page
        .locator('button')
        .filter({ hasText: /^Lisbon$/ })
        .last()
      await lisbon.waitFor()
      await sleep(300)
      await rec.click(lisbon, { dx: -60 })
      await sleep(400)
    }
    await rec.key('Meta+Enter')
    // The drawer closes and the row leaves while the camera pulls out.
    await sleep(450)
    unzoom()
    await sleep(500)
    // The note is in the sidebar's Lisbon folder now.
    zoom(200, 240, 1.8)
    const note = await sidebarItem(page, /^Sintra/)
    await rec.glide(note.x + 60, note.y + 26, 800)
  },
  async task({ rec, page, zoom, unzoom, at, sleep }) {
    unzoom()
    await at(0.4)
    await rec.click(thoughtRow(page), { dx: -140 })
    const asTask = panel(page).getByRole('radio', { name: 'Task' })
    await asTask.waitFor()
    const a = await panel(page).boundingBox()
    zoom(a.x + a.width / 2, 300, 1.6)
    await sleep(600)
    await rec.click(asTask)
    const due = panel(page).getByRole('button', { name: /^Due: / })
    await due.waitFor()
    await sleep(350)
    await rec.click(due, { dx: -90 })
    const today = page
      .getByRole('button', { name: /^Today/ })
      .filter({ hasText: /^Today\s*\w{3} \d+$/ })
    await today.waitFor()
    await sleep(300)
    await rec.click(today)
    await sleep(300)
  },
  // No caption: Add task sits at the window's bottom edge, where a step caption would cover it.
  // One shot holds the button and today's tasks in the day panel: the click, then the task.
  async done({ rec, page, zoom, sleep }) {
    zoom(1200, 640, 1.6)
    await sleep(250)
    // Its left part: the right part can sit under a fading toast.
    await rec.click(panel(page).getByRole('button', { name: 'Add task' }), { dx: -22 })
    // The day panel lists it about a second later.
    const row = page.locator('[data-slot="day-panel-inner"]').getByText(THOUGHT)
    await row.waitFor()
    await sleep(200)
    const r = await rec.center(row)
    await rec.glide(r.x + 40, r.y + 28, 700)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the link was filed as a note in Lisbon',
    (query) => {
      const [i] = query(
        "SELECT filed_to FROM inbox_items WHERE type = 'link' AND title LIKE 'Sintra%'"
      )
      return i?.filed_to === 'Lisbon/Sintra - Wikipedia.md' ? null : `got ${JSON.stringify(i)}`
    }
  ],
  [
    'the thought is a task due today',
    (query) => {
      const [t] = query(`SELECT due_date FROM tasks WHERE title = '${THOUGHT}'`)
      return t?.due_date === day(0) ? null : `got ${JSON.stringify(t)}`
    }
  ]
]
