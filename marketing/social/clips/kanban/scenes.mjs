// List or board: Website Redesign's tasks as a list, one click turns them into a board whose
// columns are the project's own statuses. A card dragged from Backlog to Design, then the Review
// status renamed "Waiting on client" in the project's settings, and the board's column follows.
import { settle } from '../../engine/kit.mjs'

const CARD = 'Build style guide page'
const RENAMED = 'Waiting on client'
const column = (page, name) => page.locator(`section[aria-label^="${name} column"]`)

export async function setup({ page, L }) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click()
  await page.waitForTimeout(900)
  if (await L('[aria-label="Resize Day Panel"]').count())
    await L('[aria-label="Day Panel"]').click()
  await page.getByRole('combobox', { name: 'Select project' }).click()
  await page.waitForTimeout(400)
  await page
    .getByRole('option', { name: /Website Redesign/ })
    .first()
    .click()
  await page.waitForTimeout(600)
  if (
    (await page.getByRole('radio', { name: 'List view' }).getAttribute('aria-checked')) !== 'true'
  )
    await page.getByRole('radio', { name: 'List view' }).click()
  await settle(page, 900, 600)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const k = await rec.center(page.getByRole('radio', { name: 'Kanban view' }))
    await rec.glide(k.x - 60, k.y + 50, 1800)
  },
  async board({ rec, page, zoom, sleep }) {
    await rec.click(page.getByRole('radio', { name: 'Kanban view' }))
    await sleep(350)
    // Four columns, x 324 to 1448: 1.5 keeps Backlog to Done in frame, the caption below the cards.
    zoom(880, 300, 1.5)
    await sleep(500)
    await rec.glide(760, 380, 1000)
  },
  async drag({ rec, page, zoom, sleep }) {
    const c = await rec.center(page.getByText(CARD, { exact: true }).first())
    const d = await rec.center(page.getByText('Mobile navigation', { exact: true }).first())
    // Backlog and Design side by side, so the card stays in frame the whole way.
    zoom(600, 260, 1.8)
    await rec.glide(c.x, c.y, 700)
    await sleep(200)
    rec.mark('drag-start')
    await page.mouse.down()
    await sleep(120)
    await rec.glide(c.x + 12, c.y + 6, 150)
    await rec.glide(d.x, d.y + 60, 1000)
    await sleep(250)
    await page.mouse.up()
    rec.mark('drag-end')
    await sleep(300)
    await rec.glide(d.x + 60, d.y + 150, 600)
  },
  async rename({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await rec.click(page.getByRole('combobox', { name: 'Select project' }), { dx: 40 })
    await sleep(450)
    // Come at the row's gear from its right end: the home toggle left of it opens a tooltip over
    // the gear when the pointer crosses it, and the click then closes the picker instead.
    const gear = page.getByRole('button', { name: 'Edit Website Redesign' })
    const g = await rec.center(gear)
    await rec.glide(g.x + 32, g.y, 600)
    await sleep(150)
    await rec.click(gear)
    await sleep(600)
    const review = page.getByRole('dialog').getByPlaceholder('Status name').nth(2)
    const r = await rec.center(review)
    zoom(794, r.y - 60, 2)
    await sleep(500)
    await rec.click(review, { dx: -40 })
    await rec.key('ControlOrMeta+a')
    await sleep(200)
    await rec.type(RENAMED, { cps: 13 })
  },
  // No caption: Save sits at the dialog's foot, in the caption band at any zoom.
  async save({ rec, page, zoom, unzoom, sleep }) {
    const save = page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true })
    // Save sits below the window's edge until the dialog scrolls.
    await rec.glide(800, 600, 350)
    for (let i = 0; i < 12 && (await save.boundingBox()).y + 40 > 900; i++) {
      await page.mouse.wheel(0, 40)
      await sleep(40)
    }
    const s = await rec.center(save)
    zoom(860, s.y - 120, 1.6)
    await sleep(250)
    await rec.click(save)
    await sleep(450)
    unzoom()
  },
  async follows({ rec, page, zoom, sleep }) {
    await sleep(300)
    const header = column(page, RENAMED).getByText(RENAMED, { exact: true })
    const h = await header.boundingBox()
    zoom(h.x + h.width / 2 + 20, h.y + 90, 1.9)
    // Beside the header, so the pointer hides neither it nor the cards under it.
    await rec.glide(h.x + h.width + 40, h.y + h.height / 2 + 6, 800)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'Card moved to Design',
    (q) => {
      const [t] = q(
        `SELECT s.name FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE t.title = '${CARD}'`
      )
      if (t?.name !== 'Design') return JSON.stringify(t)
      return undefined
    }
  ],
  [
    'Review renamed',
    (q) => {
      const names = q(
        `SELECT s.name FROM statuses s JOIN projects p ON p.id = s.project_id WHERE p.name = 'Website Redesign' ORDER BY s.position`
      ).map((s) => s.name)
      if (names.join() !== `Backlog,Design,${RENAMED},Done`) return JSON.stringify(names)
      return undefined
    }
  ]
]
