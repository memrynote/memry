// Agent Chat's model picker lists every backend it can run on: the Claude Code, Codex and
// Antigravity CLIs found on this machine, and a local model (Settings -> AI & Agents -> Agents).
// Nothing is sent: the clip only opens the picker, switches the model chip and opens the Local
// model settings. The "Detected" rows are the real PATH detection on the filming machine.
import { closeOtherTabs, open, scrollTo, settle } from '../../engine/kit.mjs'

const NOTE = 'Weekly sync with Sam'
const chip = (page) => page.getByRole('button', { name: /Agent model settings/ })
const item = (page, name) => page.getByRole('menuitem', { name, exact: true }).first()

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  await page.getByRole('tab', { name: 'Agent' }).click()
  await page.waitForTimeout(1500)
  const enable = page.getByRole('button', { name: 'Enable Agent chat' })
  if (await enable.count()) {
    await enable.click()
    await page.waitForTimeout(2500)
  }
  // Start every take on Claude Opus.
  await chip(page).click()
  await page.waitForTimeout(500)
  await page.getByText('Model', { exact: true }).last().click()
  await page.waitForTimeout(600)
  await item(page, 'Opus').click()
  await page.waitForTimeout(600)
  await settle(page, 1000, 600)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const c = await rec.center(chip(page))
    await rec.glide(c.x - 30, c.y - 40, 1700)
  },
  async menu({ rec, page, zoom, sleep, at }) {
    zoom(1360, 700, 1.5)
    await sleep(500)
    await rec.click(chip(page))
    await sleep(500)
    await rec.click(page.getByText('Model', { exact: true }).last())
    await sleep(700)
    const codex = await rec.center(item(page, 'GPT-5.4'))
    await rec.glide(codex.x, codex.y, 900)
    await sleep(500)
    const agy = await rec.center(item(page, 'Gemini 3.1 Pro (High)'))
    await rec.glide(agy.x, agy.y, 900)
    await at(4.0)
  },
  async switch({ rec, page, at, sleep }) {
    await rec.click(item(page, 'GPT-5.4'))
    await sleep(900)
    const c = await rec.center(chip(page))
    await rec.glide(c.x - 20, c.y - 50, 700)
    await at(3.2)
  },
  async local({ rec, page, unzoom, zoom, sleep, at }) {
    await rec.click(chip(page))
    await sleep(500)
    await rec.click(page.getByText('Model', { exact: true }).last())
    await sleep(700)
    await rec.click(page.getByText(/Set up in Settings/).first())
    unzoom()
    await page.getByText('Agent runtimes').waitFor()
    await sleep(700)
    const local = page.getByText('Local model', { exact: true })
    await scrollTo({ rec, page, sleep }, local, 200, { x: 800, y: 500 })
    zoom(800, 380, 1.6)
    await sleep(500)
    await rec.click(local)
    await sleep(900)
    await at(7.0)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
