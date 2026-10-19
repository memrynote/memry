// Apple Journal import: Settings > Import lists Apple Journal; six real export pages (HTML, one
// per day, vault/assets/apple-journal-import-export, written by vault.mjs) go through the shipped
// importer and land as dated notes in an "Apple Journal" folder. The native file picker can't be
// filmed, so setup answers the next picker call in the main process with the six paths; the click
// on "Choose file…" and everything after it is the real app.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeOtherTabs, expandSection, open, settle } from '../../engine/kit.mjs'

const ASSETS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vault/assets/apple-journal-import-export'
)
const FILES = fs
  .readdirSync(ASSETS)
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((f) => path.join(ASSETS, f))
const OPEN = FILES[2].replace(/^.*\/|\.html$/g, '')

const mainEval = (expr) =>
  execFileSync(
    'node',
    [path.join(process.env.MEMRY_SOCIAL_APP, 'apps/desktop/scripts/agent-app.mjs'), 'eval', expr],
    { encoding: 'utf8' }
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

const source = (page) => page.locator('[data-testid=import-source-apple-journal]')
const dialog = (page) => page.getByRole('dialog')

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
  answerNextPicker(FILES)
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
    await scrollBy(ctx, (await source(page).boundingBox()).y - 380, 2400)
    await at(3.6)
  },
  async pick({ rec, page, zoom, sleep, at }) {
    await rec.click(source(page), { dx: -200 })
    await dialog(page).waitFor()
    zoom(800, 495, 1.7)
    await sleep(900)
    await rec.click(page.getByRole('button', { name: 'Choose file…' }))
    await dialog(page).getByText('6 files selected').waitFor()
    await sleep(500)
    await rec.glide(700, 560, 900)
    await at(4.2)
  },
  async import({ rec, page, at }) {
    await rec.click(dialog(page).getByRole('button', { name: 'Start import' }))
    await dialog(page).getByText('Import complete').waitFor()
    await rec.glide(840, 500, 700)
    await at(2.6)
    await rec.click(page.getByRole('button', { name: 'Done', exact: true }))
  },
  async folder({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(300)
    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    const row = page.getByText('Apple Journal', { exact: true }).first()
    await row.waitFor()
    const b = await row.boundingBox()
    zoom(300, b.y + 110, 1.8)
    await sleep(400)
    const expand = page
      .getByRole('button', { name: 'Expand folder' })
      .filter({ has: page.locator('xpath=self::*') })
    const buttons = await expand.all()
    for (const e of buttons) {
      const eb = await e.boundingBox()
      if (eb && Math.abs(eb.y + eb.height / 2 - (b.y + b.height / 2)) < 10) {
        await rec.click(e)
        break
      }
    }
    await page.getByText(OPEN, { exact: true }).first().waitFor()
    await at(4.0)
  },
  async note({ rec, page, zoom, sleep, at }) {
    await rec.click(page.getByText(OPEN, { exact: true }).first())
    await page.getByText('Everyone left with a clearer idea').waitFor()
    await sleep(500)
    const t = await page.getByText('Everyone left with a clearer idea').boundingBox()
    zoom(t.x + 280, t.y + 20, 1.6)
    await rec.glide(t.x + 480, t.y + 70, 1000)
    await at(4.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
