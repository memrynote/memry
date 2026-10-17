// Import from anywhere: Settings > Import lists all 15 sources, and two real Todoist project
// exports (vault/assets/import-sources-todoist/*.csv) go through the shipped Todoist importer.
// They arrive as two projects with their dates, priorities and subtasks.
//
// The native file picker can't be filmed or driven, so setup answers the next picker call in
// the main process with the two CSV paths; the click on "Choose file…" and everything after it
// is the real app. OneNote is in the release's list only when ONENOTE_CLIENT_ID is set (the
// release build ships it in app-config), so record with:
//   ONENOTE_CLIENT_ID=social-clip-placeholder node marketing/social/engine/clip.mjs import-sources --slot 7
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeOtherTabs, expandSection, open, settle } from '../../engine/kit.mjs'

const ASSETS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vault/assets/import-sources-todoist'
)
const CSVS = ['Freelance admin.csv', 'Design workshop.csv'].map((f) => path.join(ASSETS, f))

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

/** On camera: wheel-scroll by `dy` CSS px over `ms`, eased, under the pointer. */
async function scrollBy({ page, sleep }, dy, ms) {
  const start = Date.now()
  let sent = 0
  for (let k = 0; k < 1;) {
    k = Math.min(1, (Date.now() - start) / ms)
    const step = Math.round(dy * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)) - sent
    if (step) await page.mouse.wheel(0, step)
    sent += step
    await sleep(16)
  }
}

const source = (page, id) => page.locator(`[data-testid=import-source-${id}]`)
const dialog = (page) => page.getByRole('dialog')

export async function setup({ page }) {
  await expandSection(page, 'Projects')
  // "Back to app" returns to this note (Home would greet with today's date).
  await open(page, 'Ideas backlog')
  await closeOtherTabs(page, 'Ideas backlog')
  // The day panel's month grid would date the clip; the hub gets its width instead.
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Import', exact: true }).first().click()
  await page.waitForTimeout(900)
  const sources = await page.locator('[data-testid^=import-source-]').count()
  if (sources !== 15)
    throw new Error(`Import lists ${sources} sources, not 15. Is ONENOTE_CLIENT_ID set?`)
  answerNextPicker(CSVS)
  await settle(page, 700, 450)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.4)
    await rec.glide(900, 520, 2200)
  },
  async sources(ctx) {
    const { rec, page, zoom, at } = ctx
    zoom(950, 420, 1.5)
    await rec.glide(960, 560, 600)
    // Note apps scroll up, the task apps and plain files come in, Todoist stops mid-frame.
    await scrollBy(ctx, (await source(page, 'todoist').boundingBox()).y - 300, 2600)
    await at(4.0)
  },
  async pick({ rec, page, zoom, sleep, at }) {
    await rec.click(source(page, 'todoist'), { dx: -200 })
    await dialog(page).waitFor()
    zoom(800, 495, 1.7)
    await sleep(900)
    await rec.click(page.getByRole('button', { name: 'Choose file…' }))
    await dialog(page).getByText('Design workshop').waitFor()
    await sleep(500)
    await rec.glide(700, 560, 900)
    await at(4.6)
  },
  async import({ rec, page, at }) {
    await rec.click(dialog(page).getByRole('button', { name: 'Import', exact: true }))
    await dialog(page).getByText('Import complete').waitFor()
    await rec.glide(840, 500, 700)
    await at(2.6)
    await rec.click(page.getByRole('button', { name: 'Done', exact: true }))
  },
  async projects({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(300)
    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    await page.getByRole('button', { name: 'Design workshop', exact: true }).waitFor()
    zoom(300, 330, 1.8)
    await sleep(300)
    await rec.glide(170, 352, 800)
    await at(3.9)
  },
  async tasks({ rec, page, zoom, sleep, at }) {
    await rec.click(page.getByRole('button', { name: 'Freelance admin', exact: true }), {
      dx: -40,
      pause: 120
    })
    await page.getByRole('tab', { name: /^Tasks/ }).waitFor()
    zoom(790, 300, 1.7)
    await sleep(350)
    await rec.click(page.getByRole('tab', { name: /^Tasks/ }), { pause: 120 })
    const expand = page.getByRole('button', { name: 'Expand subtasks' })
    await expand.waitFor()
    await sleep(350)
    await rec.click(expand, { pause: 120 })
    await page.getByText('Export the bank statement').waitFor()
    await sleep(300)
    await rec.glide(960, 330, 900)
    await at(5.3)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'both CSVs became projects with 7 tasks, 2 of them subtasks',
    (query) => {
      const rows = query(
        `SELECT p.name, COUNT(t.id) n, SUM(t.parent_id IS NOT NULL) subs FROM projects p
         JOIN tasks t ON t.project_id = p.id WHERE p.name IN ('Freelance admin', 'Design workshop') GROUP BY p.name`
      )
      const bad = rows.filter((r) => r.n !== 7 || r.subs !== 2)
      return rows.length === 2 && !bad.length ? null : JSON.stringify(rows)
    }
  ]
]
