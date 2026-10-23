// The vault activity log after an import. Off camera, the vault gets a day's worth of real
// activity: a note saved into it by another editor and later deleted, a photo copied in, and a
// Markdown import of four notes with one image (vault/assets/activity-log-notes). The take opens
// on that import's summary; Done, then Settings > Vault & Data shows the log the app wrote. Last,
// a Sketch file lands in the vault folder (as Finder would put it there) and the log adds it
// live, skipped, with the reason.
//
// Every row is written by the app itself (watcher, import runner). The native folder picker
// can't be filmed or driven, so setup answers the next picker call in the main process with the
// import folder's path.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vault/assets')
const PHOTO = path.join(ASSETS, 'obsidian-vault-sketchbook/attachments/tram-28.jpg')
const SKETCH = 'Studio North/homepage-v3.sketch'

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

/** Wait until the app's log holds `n` more entries than `before` (it writes them itself). */
async function logged(page, before, n = 1) {
  for (let i = 0; i < 50; i++) {
    const { entries } = await page.evaluate(() =>
      window.api.vaultActivity.list({ limit: 200, filter: 'all' })
    )
    if (entries.length >= before + n) return entries.length
    await page.waitForTimeout(200)
  }
  throw new Error('The vault activity log did not record the change')
}
const count = async (page) =>
  (await page.evaluate(() => window.api.vaultActivity.list({ limit: 200, filter: 'all' }))).entries
    .length

const row = (page, text) =>
  page.getByTestId('vault-activity-list').locator('li').filter({ hasText: text }).first()

let vault
export async function setup({ page }) {
  vault = (await page.evaluate(() => window.api.vault.getStatus())).path
  await open(page, 'Ideas backlog')
  await closeOtherTabs(page, 'Ideas backlog')
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }

  // Files that came and went outside the app, a few seconds apart, as on a real afternoon.
  let n = await count(page)
  const drop = (rel, from) => {
    fs.copyFileSync(from, path.join(vault, rel))
  }
  drop(
    'Ideas/Old newsletter draft.md',
    path.join(ASSETS, 'activity-log-drop/Old newsletter draft.md')
  )
  n = await logged(page, n)
  drop('Lisbon/tram-28.jpg', PHOTO)
  n = await logged(page, n)
  await page.waitForTimeout(1500)
  fs.rmSync(path.join(vault, 'Ideas/Old newsletter draft.md'))
  n = await logged(page, n)

  // The import: four notes and the image one of them shows, as an export folder.
  const folder = path.join(process.env.TMPDIR ?? '/tmp', 'activity-log-import/Notes export')
  fs.rmSync(path.dirname(folder), { recursive: true, force: true })
  fs.cpSync(path.join(ASSETS, 'activity-log-notes'), folder, { recursive: true })
  fs.mkdirSync(path.join(folder, 'images'))
  fs.copyFileSync(PHOTO, path.join(folder, 'images/tram-28.jpg'))
  answerNextPicker([folder])
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Import', exact: true }).first().click()
  await page.waitForTimeout(900)
  const md = page.locator('[data-testid=import-source-markdown]')
  await page.mouse.move(950, 500)
  for (let i = 0; i < 30 && (await md.boundingBox()).y > 430; i++) {
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(40)
  }
  await md.click()
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('dialog').getByText('1 file selected').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Start import' }).click()
  await page.getByRole('dialog').getByText('Import complete').waitFor()
  await logged(page, n)
  await settle(page, 900, 640)
}

export const scenes = {
  async hook({ rec, page, zoom, at }) {
    const d = await page.getByRole('dialog').boundingBox()
    zoom(d.x + d.width / 2, d.y + d.height / 2, 1.6)
    await at(0.6)
    const c = await rec.center(page.getByRole('button', { name: 'Done', exact: true }))
    await rec.glide(c.x - 40, c.y + 40, 1500)
    await rec.glide(c.x, c.y, 700)
  },
  async open({ rec, page, zoom, sleep, at }) {
    await rec.click(page.getByRole('button', { name: 'Done', exact: true }), { pause: 80 })
    // The lower half of the window: the settings nav and, once it loads, the log. The vault's
    // path (a temp folder) sits above it, out of frame.
    zoom(620, 590, 1.5)
    await sleep(500)
    await rec.click(page.getByRole('button', { name: 'Vault & Data', exact: true }), { pause: 100 })
    const list = page.getByTestId('vault-activity-list')
    await list.waitFor()
    await sleep(400)
    const b = await list.boundingBox()
    zoom(b.x + b.width / 2, b.y + 70, 1.6)
    await rec.glide(b.x + b.width / 2 - 60, b.y + b.height + 30, 900)
    await at(4.5)
  },
  async import({ rec, page, zoom, at }) {
    const r = await row(page, 'Markdown import').boundingBox()
    zoom(r.x + r.width / 2, r.y + r.height / 2 + 40, 1.9)
    // Just past "4 imported · 1 attachment".
    await rec.glide(r.x + 250, r.y + r.height - 6, 900)
    await at(3.5)
  },
  async added({ rec, page, zoom, at }) {
    const a = await row(page, 'Removed Ideas/Old newsletter draft.md').boundingBox()
    const b = await row(page, 'Added Ideas/Old newsletter draft.md').boundingBox()
    zoom(a.x + a.width / 2, (a.y + b.y + b.height) / 2, 1.9)
    await rec.glide(a.x + 340, (a.y + b.y + b.height) / 2 + 10, 900)
    await at(3.7)
  },
  async skipped({ rec, page, zoom, sleep, at }) {
    const list = await page.getByTestId('vault-activity-list').boundingBox()
    zoom(list.x + list.width / 2, list.y + 60, 1.9)
    await sleep(700)
    // The Sketch file lands in the vault folder, as Finder would put it there.
    fs.copyFileSync(
      path.join(ASSETS, 'activity-log-drop/homepage-v3.sketch'),
      path.join(vault, SKETCH)
    )
    const r = row(page, `Skipped ${SKETCH}`)
    await r.waitFor({ timeout: 8000 })
    await sleep(250)
    const b = await r.boundingBox()
    // Just past the reason, "...so the file was left as is."
    await rec.glide(b.x + 380, b.y + b.height - 8, 900)
    await at(3.9)
    // Only the problems.
    await rec.click(page.getByRole('radio', { name: 'Skipped and failed' }), { pause: 120 })
    await page
      .getByTestId('vault-activity-list')
      .locator('li')
      .filter({ hasText: 'Markdown import' })
      .waitFor({ state: 'detached' })
    await sleep(300)
    await rec.glide(b.x + 380, b.y + b.height - 8, 700)
    await at(6.3)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the import reached the vault: 4 notes under Markdown/',
    (query) => {
      const [r] = query(`SELECT COUNT(*) n FROM note_metadata WHERE path LIKE 'Markdown/%.md'`)
      return r.n === 4 ? null : JSON.stringify(r)
    }
  ]
]
