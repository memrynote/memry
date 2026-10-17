// Checklists become tasks on import: a folder of three markdown notes with checklists
// (vault/assets/import-checklists-notes) goes through the shipped Markdown importer. In the
// imported note every checkbox is a task row, the checked ones arrive checked, and the nested
// ones stay under their parent.
//
// The native folder picker can't be filmed or driven, so setup answers the next picker call in
// the main process with the folder's path; "Choose folder…" and everything after it is the
// real app. The importer only reads the folder.
//
// Known gap in v2026-10-15 (reported, not shown): checked items get completedAt but no done
// status, so the Tasks page and the project hub list them as open. The clip stays in the note,
// where they are checked, and its captions claim only that.
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeOtherTabs, expandSection, open, settle } from '../../engine/kit.mjs'

const FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vault/assets/import-checklists-notes'
)
const NOTE = 'Studio North launch'

/** The running app's main process, through agent-app.mjs (clip.mjs set the slot's ports). */
const mainEval = (expr) =>
  execFileSync(
    'node',
    [path.join(process.env.MEMRY_SOCIAL_APP, 'apps/desktop/scripts/agent-app.mjs'), 'eval', expr],
    {
      encoding: 'utf8'
    }
  ).trim()

/** Off camera: the next native file picker returns `paths` instead of opening. */
function answerNextPicker(paths) {
  mainEval(`(() => {
    const { dialog } = process.mainModule.require('electron')
    const real = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = real
      return { canceled: false, filePaths: ${JSON.stringify(paths)} }
    }
    return 'armed'
  })()`)
}

/** The sidebar row named `name` (the same text shows in tabs and breadcrumbs too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

const dialog = (page) => page.getByRole('dialog')
const task = (page, title) => page.getByRole('group', { name: title })

export async function setup({ page }) {
  await expandSection(page, 'Collections')
  // "Back to app" returns to this note (Home would greet with today's date).
  await open(page, 'Ideas backlog')
  await closeOtherTabs(page, 'Ideas backlog')
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Import', exact: true }).first().click()
  await page.waitForTimeout(900)
  // The Files group (Markdown, HTML, CSV) in the middle of the window.
  const md = page.locator('[data-testid=import-source-markdown]')
  await page.mouse.move(950, 500)
  for (let i = 0; i < 30 && (await md.boundingBox()).y > 430; i++) {
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(40)
  }
  answerNextPicker([FOLDER])
  await settle(page, 1000, 700)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const c = await rec.center(page.locator('[data-testid=import-source-markdown]'))
    await rec.glide(c.x - 120, c.y + 60, 2200)
  },
  async folder({ rec, page, zoom, unzoom, sleep, at }) {
    await rec.click(page.locator('[data-testid=import-source-markdown]'), { dx: -200, pause: 120 })
    await dialog(page).waitFor()
    const d = await dialog(page).boundingBox()
    zoom(d.x + d.width / 2, d.y + d.height / 2, 1.7)
    await sleep(700)
    await rec.click(page.getByRole('button', { name: 'Choose folder…' }), { pause: 120 })
    await dialog(page).getByText('1 file selected').waitFor()
    await sleep(450)
    await rec.click(dialog(page).getByRole('button', { name: 'Start import' }), { pause: 120 })
    await dialog(page).getByText('Import complete').waitFor()
    await rec.glide(d.x + d.width / 2 + 60, d.y + d.height / 2 + 30, 600)
    await at(5.0)
    await rec.click(page.getByRole('button', { name: 'Done', exact: true }), { pause: 80 })
    unzoom()
    await sleep(300)
    await rec.click(page.getByRole('button', { name: 'Back to app' }), { pause: 100 })
    await (await sidebarRow(page, 'Markdown')).waitFor()
  },
  async open({ rec, page, zoom, sleep, at }) {
    await rec.click(await sidebarRow(page, 'Markdown'), { pause: 100 })
    const row = await sidebarRow(page, NOTE)
    await sleep(300)
    await rec.click(row, { pause: 100 })
    await task(page, 'Launch day').waitFor()
    zoom(950, 370, 1.6)
    await sleep(300)
    await rec.glide(1000, 560, 700)
    await at(4.3)
  },
  async checked({ rec, page, zoom, at }) {
    zoom(860, 320, 1.95)
    const c = await rec.center(task(page, 'Homepage sign-off from Jonas'))
    await rec.glide(c.x + 140, c.y + 18, 900)
    await at(3.3)
  },
  async subtasks({ rec, page, zoom, at }) {
    zoom(880, 450, 1.95)
    const c = await rec.center(task(page, 'Switch the DNS'))
    await rec.glide(c.x + 160, c.y + 14, 900)
    await at(3.5)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'Studio North launch: 7 tasks, 3 checked, 3 nested under Launch day',
    (query) => {
      const [r] = query(
        `SELECT COUNT(*) n, SUM(completed_at IS NOT NULL) done, SUM(parent_id IS NOT NULL) subs FROM tasks WHERE title IN
         ('Homepage sign-off from Jonas', 'Export the image set for Sam', 'Launch day', 'Write the announcement post',
          'Switch the DNS', 'Check every page on a phone', 'Send the handover doc to Lea')`
      )
      return r.n === 7 && r.done === 3 && r.subs === 3 ? null : JSON.stringify(r)
    }
  ]
]
