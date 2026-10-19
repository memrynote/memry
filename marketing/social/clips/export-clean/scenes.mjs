// Export a note to PDF and open the result. The note (vault.mjs) has a %% private comment %%, a
// footnote and a checklist line (which the app tags with an internal block id in the file). The
// PDF the app writes keeps the text and the numbered footnote and leaves the comment and the id
// out. The native save dialog can't be filmed or driven, so setup answers the next
// showSaveDialog call in the main process with a path in the vault; everything else is the app:
// the export dialog, printToPDF, the watcher indexing the file, and the in-app PDF viewer.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'
import { NOTE } from './vault.mjs'

const PDF = 'Hero summary for Lea'
const mainEval = (expr) =>
  execFileSync(
    'node',
    [path.join(process.env.MEMRY_SOCIAL_APP, 'apps/desktop/scripts/agent-app.mjs'), 'eval', expr],
    { encoding: 'utf8' }
  ).trim()

let pdfPath
export async function setup({ page }) {
  const vault = (await page.evaluate(() => window.api.vault.getStatus())).path
  pdfPath = path.join(vault, 'Studio North', `${PDF}.pdf`)
  fs.rmSync(pdfPath, { force: true })
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  mainEval(`(() => {
    const { dialog } = process.mainModule.require('electron')
    const real = dialog.showSaveDialog
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = real
      return { canceled: false, filePath: ${JSON.stringify(pdfPath)} }
    }
    return 'armed'
  })()`)
  await page
    .getByText('Keep as checkbox')
    .waitFor({ timeout: 8000 })
    .catch(() => {})
  await settle(page, 1000, 700)
  await page.waitForTimeout(6000)
}

const more = (page) => page.getByRole('button', { name: 'More actions' })
const dialogButton = (page) => page.getByRole('button', { name: 'Export', exact: true })

export const scenes = {
  async hook({ rec, page, zoom, at }) {
    zoom(790, 340, 1.5)
    await at(0.6)
    const c = await rec.center(more(page))
    await rec.glide(c.x - 200, c.y + 60, 1700)
  },
  async menu({ rec, page, zoom, sleep, at }) {
    zoom(1100, 200, 1.6)
    await sleep(500)
    await rec.click(more(page))
    await sleep(700)
    await rec.click(page.getByRole('option', { name: 'Export' }))
    await at(3.0)
  },
  async export({ rec, page, zoom, sleep, at }) {
    zoom(800, 480, 1.5)
    await sleep(700)
    await rec.click(dialogButton(page))
    await page
      .getByRole('button', { name: 'Export', exact: true })
      .waitFor({ state: 'detached', timeout: 20_000 })
    await rec.glide(780, 330, 700)
    await at(3.6)
  },
  async find({ rec, page, zoom, sleep, at }) {
    zoom(800, 330, 1.6)
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }))
    await sleep(400)
    await rec.type(PDF, { cps: 12 })
    await page.getByRole('option').first().waitFor()
    await sleep(700)
    await rec.key('Enter')
    await page.getByRole('tab', { name: PDF }).waitFor()
    await sleep(1500)
    await at(4.0)
  },
  async clean({ rec, zoom, sleep, at }) {
    zoom(860, 470, 1.7)
    await rec.glide(1000, 420, 900)
    await sleep(1500)
    await rec.glide(980, 560, 900)
    await at(5.0)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the PDF is in the vault',
    () => (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000 ? null : 'no pdf')
  ]
]
