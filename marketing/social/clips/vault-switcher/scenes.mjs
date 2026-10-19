// Three vaults, one shortcut: Cmd+Shift+O opens the switcher on the current vault, arrow keys move,
// Enter switches. Setup registers Work and Family through the app's own Open vault action (the
// folder picker is stubbed), then returns to Maya's vault, with a note open.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const SLOT_TMP = process.env.TMPDIR

const agentEval = (code) =>
  execFileSync(
    'node',
    [path.join(process.env.MEMRY_SOCIAL_APP, 'apps/desktop/scripts/agent-app.mjs'), 'eval', code],
    { encoding: 'utf8', env: process.env }
  )

const list = (page) => page.getByRole('button', { name: /Open the vault list/ })

async function addVault(page, dir) {
  agentEval(
    `(()=>{const {dialog}=process.mainModule.require('electron');dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(dir)}]});return 'ok'})()`
  )
  await list(page).click()
  await page.waitForTimeout(500)
  await page.getByRole('option', { name: 'Open vault' }).click()
  await page
    .getByRole('button', { name: new RegExp(`^${path.basename(dir)}\\. Open the vault list`) })
    .waitFor({ timeout: 20000 })
  await page.waitForTimeout(6000)
}

export async function setup({ page }) {
  const root = path.join(SLOT_TMP, 'vs')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const extra = path.resolve(
    `/tmp/memry-social/vaults/${new Date().toLocaleDateString('sv')}/vault-switcher/extra`
  )
  for (const name of ['Work', 'Family'])
    fs.cpSync(path.join(extra, name), path.join(root, name), { recursive: true })
  await addVault(page, path.join(root, 'Work'))
  await addVault(page, path.join(root, 'Family'))
  await page.keyboard.press('Meta+Shift+o')
  await row(page, 'Maya').waitFor()
  await page.waitForTimeout(300)
  await row(page, 'Maya').click()
  await list(page).filter({ hasText: 'Maya' }).waitFor({ timeout: 20000 })
  await page.waitForTimeout(3000)
  // Opening vaults can leave the window a few px narrower, and frames of mixed size break the take.
  agentEval(
    `(()=>{const {BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find((w)=>w.webContents.getURL().includes('renderer/index.html'));w.setContentSize(1600,900);return 'ok'})()`
  )
  await page.waitForTimeout(1000)
  const size = await page.evaluate(() => [innerWidth, innerHeight])
  if (size[0] !== 1600 || size[1] !== 900) throw new Error(`window is ${size}`)
  await open(page, 'Website Redesign Brief')
  await closeOtherTabs(page, 'Website Redesign Brief')
  await settle(page, 1000, 650)
}

const row = (page, name) =>
  page.locator('[data-slot=picker-list] button:visible').filter({ hasText: name }).first()

export const scenes = {
  async hook({ rec, at }) {
    await at(0.6)
    await rec.glide(900, 500, 1500)
  },
  async open({ rec, page, zoom, sleep, at }) {
    zoom(230, 100, 1.6)
    await sleep(500)
    await rec.key('Meta+Shift+o')
    await row(page, 'Work')
      .waitFor({ timeout: 4000 })
      .catch(async (e) => {
        await page.screenshot({ path: '/tmp/s4dbg.png' })
        throw e
      })
    await at(3.8)
  },
  async pick({ rec, page, sleep, at }) {
    await rec.key('ArrowDown')
    await sleep(700)
    await rec.key('ArrowDown')
    await sleep(900)
    await rec.key('ArrowUp')
    await sleep(900)
    await rec.key('Enter')
    await list(page).filter({ hasText: 'Work' }).waitFor({ timeout: 20000 })
    await at(4.4)
  },
  async arrive({ rec, page, sleep, at }) {
    await sleep(600)
    await at(4.2)
  },
  async back({ rec, page, sleep, at }) {
    await rec.key('Meta+Shift+o')
    await row(page, 'Work').waitFor()
    await sleep(700)
    await rec.key('ArrowUp')
    await sleep(800)
    await rec.key('Enter')
    await list(page).filter({ hasText: 'Maya' }).waitFor({ timeout: 20000 })
    await at(4.2)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
