// Templates from any note: Design review (agenda, decisions, next steps; tagged meeting, with a
// client property) is saved as a template from its ⋯ menu, and the dialog says what comes along.
// In Review with Jonas, a new line between its two lines, `/design` offers the template by name
// in the slash menu's Templates group, and Enter drops its body there; both lines stay as they
// were. (The "Insert template content…" row opens a picker titled "Apply a Template / Replace this
// note's content", which inserts too but says otherwise, so the clip uses the direct row.)
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const FIRST = 'Thursday 14:00 at the Studio North office.'
const LAST = 'Bring the printed case studies.'

export async function setup({ page }) {
  await open(page, 'Design review')
  await closeOtherTabs(page, 'Design review')
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Meetings')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  await settle(page)
}

/** The sidebar row named `name` (the same text can show in the main pane too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

const more = (page) => page.getByTestId('note-more-menu').first()
const dialog = (page) => page.getByTestId('save-note-as-template-dialog')

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(more(page))
    await rec.glide(c.x - 220, c.y + 160, 1000)
    await rec.glide(c.x - 4, c.y + 2, 900)
  },
  async save({ rec, page, zoom, unzoom, sleep }) {
    zoom(1290, 240, 1.6)
    await rec.click(more(page))
    const item = page.getByRole('option', { name: 'Save as Template' })
    await item.waitFor()
    await sleep(700)
    await rec.click(item)
    await dialog(page).waitFor()
    await page.getByText(/Saves the note body/).waitFor()
    // The dialog opens mid-screen, away from the menu: pull back, then in on it.
    await sleep(350)
    unzoom()
    await sleep(700)
    const d = await dialog(page).boundingBox()
    zoom(d.x + d.width / 2, d.y + d.height / 2 + 15, 2.0)
    await rec.glide(d.x + d.width / 2 + 120, d.y + d.height / 2 + 20, 900)
  },
  async keeps({ rec, page, unzoom, sleep, at }) {
    await at(2.2)
    await rec.click(page.getByRole('button', { name: 'Save template' }))
    await page.getByText('Template saved').waitFor()
    await sleep(300)
    unzoom()
  },
  async type({ rec, page, zoom, sleep }) {
    await rec.click(await sidebarRow(page, 'Review with Jonas'))
    await page.getByText(FIRST).waitFor()
    await sleep(500)
    const b = await page.getByText(FIRST).boundingBox()
    zoom(b.x + 280, b.y + 120, 1.7)
    await sleep(300)
    // Past the end of the line, so the caret lands after the full stop.
    await rec.click(page.getByText(FIRST), { dx: b.width / 2 + 30 })
    await sleep(350)
    await rec.key('Enter')
    await sleep(300)
    await rec.type('/design', { cps: 10 })
    await page.getByRole('option', { name: 'Design review' }).waitFor()
    const o = await rec.center(page.getByRole('option', { name: 'Design review' }))
    await rec.glide(o.x + 140, o.y + 50, 700)
  },
  async insert({ rec, page, zoom, sleep }) {
    await rec.key('Enter')
    await page.getByRole('heading', { name: 'Next steps' }).waitFor()
    await sleep(200)
    const a = await page.getByText(FIRST).boundingBox()
    const z = await page.getByText(LAST).boundingBox()
    zoom(a.x + 260, (a.y + z.y + z.height) / 2 + 40, 1.5)
    await rec.glide(a.x + a.width + 150, (a.y + z.y) / 2, 900)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

const file = () => {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, 'Meetings/Review with Jonas.md'), 'utf8')
}

export const checks = [
  [
    'the template was saved',
    (query) =>
      query("SELECT name FROM templates WHERE name = 'Design review'").length
        ? null
        : 'no Design review template'
  ],
  [
    'the body landed between the two lines, which are unchanged',
    () =>
      /Studio North office\.\n+## Agenda[\s\S]*## Next steps\n+- Who does what, by when\n+Bring the printed case studies\./.test(
        file()
      )
        ? null
        : file()
  ]
]
