// An Obsidian vault opens as it is: a copy of vault/assets/obsidian-vault-sketchbook (a
// .obsidian folder, notes with YAML frontmatter, [[wiki links]] and an ![[image embed]]) is
// opened with the vault switcher's "Open vault". Its frontmatter shows as tags and properties,
// the embed renders, and a wiki link opens its note. A check after the take compares every file
// with the asset: memrynote opened and indexed them without writing a byte.
//
// The native folder picker can't be filmed or driven, so setup answers the next picker call in
// the main process with the copy's path; "Open vault" and everything after it is the real app.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const ASSET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vault/assets/obsidian-vault-sketchbook'
)
// Obsidian's own default vault name.
const VAULT = `${process.env.TMPDIR ?? '/tmp'}/obsidian-vault-take/Obsidian Vault`
// Days since each note was last edited in Obsidian, for Home's "Recently edited".
const EDITED = {
  'Lisbon/Lisbon trip.md': 1,
  'Lisbon/Alfama.md': 2,
  'Lisbon/Sintra.md': 2,
  'People/Sam Okafor.md': 4,
  'Studio North/Homepage moodboard.md': 6,
  'Studio North/Studio North.md': 9
}

/** The running app's main process, through agent-app.mjs (clip.mjs set the slot's ports). */
const mainEval = (expr) =>
  execFileSync(
    'node',
    [path.join(process.env.MEMRY_SOCIAL_APP, 'apps/desktop/scripts/agent-app.mjs'), 'eval', expr],
    {
      encoding: 'utf8'
    }
  ).trim()

/** Every file under `dir` except memrynote's own `.memry` folder, relative path -> bytes. */
function files(dir, rel = '') {
  const out = {}
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name)
    if (e.isDirectory()) {
      if (r !== '.memry') Object.assign(out, files(dir, r))
    } else out[r] = fs.readFileSync(path.join(dir, r))
  }
  return out
}

const note = (page) => page.getByRole('textbox', { name: 'Note title' })

export async function setup({ page }) {
  // A fresh copy each take, with the edit times an Obsidian user's files would have.
  fs.rmSync(path.dirname(VAULT), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(VAULT), { recursive: true })
  fs.cpSync(ASSET, VAULT, { recursive: true })
  for (const [rel, days] of Object.entries(EDITED)) {
    const t = new Date(Date.now() - days * 864e5 - 3 * 36e5)
    fs.utimesSync(path.join(VAULT, rel), t, t)
  }
  // Opening a vault resizes the window to its saved size; the take needs 1600x900 throughout.
  mainEval(`(() => {
    const { BrowserWindow, dialog } = process.mainModule.require('electron')
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('renderer/index.html'))
    w.setMinimumSize(1600, 900)
    w.setMaximumSize(1600, 900)
    const real = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = real
      return { canceled: false, filePaths: [${JSON.stringify(VAULT)}] }
    }
    return 'armed'
  })()`)
  await open(page, 'Lisbon Itinerary')
  await closeOtherTabs(page, 'Lisbon Itinerary')
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await settle(page, 700, 520)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const c = await rec.center(page.getByRole('button', { name: 'Maya. Open the vault list' }))
    await rec.glide(c.x + 140, c.y + 160, 1300)
    await rec.glide(c.x + 8, c.y + 6, 900)
  },
  async open({ rec, page, zoom, unzoom: _unzoom, sleep, at }) {
    zoom(330, 220, 1.8)
    await rec.click(page.getByRole('button', { name: 'Maya. Open the vault list' }), { pause: 120 })
    const item = page.getByRole('option', { name: 'Open vault' })
    await item.waitFor()
    await sleep(600)
    await rec.click(item, { pause: 150 })
    await page
      .getByRole('button', { name: 'Obsidian Vault. Open the vault list' })
      .waitFor({ timeout: 15000 })
    await page.getByText('Lisbon trip', { exact: true }).first().waitFor()
    await sleep(300)
    zoom(420, 260, 1.7)
    const c = await rec.center(page.getByText('Lisbon trip', { exact: true }).first())
    await rec.glide(c.x + 30, c.y + 4, 900)
    await at(5.3)
  },
  async props({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await rec.click(page.getByText('Lisbon trip', { exact: true }).first(), { pause: 100 })
    await note(page).waitFor()
    await page.getByRole('button', { name: 'budget', exact: true }).waitFor()
    zoom(790, 230, 1.8)
    await sleep(500)
    const c = await rec.center(page.getByRole('button', { name: 'booked', exact: true }))
    await rec.glide(c.x - 60, c.y + 30, 900)
    await at(4.1)
  },
  async embed(ctx) {
    const { rec, page, zoom, sleep, at } = ctx
    zoom(790, 470, 1.45)
    await rec.glide(1150, 520, 500)
    // Wheel the image fully into view, the "Four days in Alfama" line above it.
    const line = page.locator('.wiki-link[data-target=Alfama]').first()
    for (let i = 0; i < 40; i++) {
      const left = (await line.boundingBox()).y - 205
      if (Math.abs(left) < 6) break
      await page.mouse.wheel(0, Math.sign(left) * Math.min(14, Math.abs(left)))
      await sleep(24)
    }
    await at(3.7)
  },
  async links({ rec, page, zoom, unzoom: _unzoom, sleep, at }) {
    zoom(700, 240, 1.8)
    await sleep(250)
    await rec.click(page.locator('.wiki-link[data-target=Alfama]').first(), { pause: 200 })
    await page.getByRole('tab', { name: 'Alfama' }).waitFor()
    await page.getByText('neighborhood', { exact: true }).waitFor()
    zoom(760, 300, 1.7)
    await sleep(500)
    const back = page.locator('.wiki-link[data-target="Lisbon trip"]').first()
    const c = await rec.center(back)
    await rec.glide(c.x + 20, c.y + 26, 1000)
    await at(4.3)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the vault opened and every file is byte-identical to the asset',
    () => {
      if (!fs.existsSync(path.join(VAULT, '.memry')))
        return `no .memry in ${VAULT}: the vault never opened`
      const before = files(ASSET)
      const after = files(VAULT)
      const changed = Object.keys(before).filter((f) => !after[f]?.equals(before[f]))
      const added = Object.keys(after).filter((f) => !before[f])
      return changed.length || added.length
        ? `changed: ${changed.join(', ')}; added: ${added.join(', ')}`
        : null
    }
  ]
]
