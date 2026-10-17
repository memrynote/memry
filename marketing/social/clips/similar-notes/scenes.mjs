// On-device suggestions: a fresh Lisbon note that links nothing gets its similar notes and a tag from
// the local embeddings, a mixed board gets two suggested groups, and Settings shows the model is
// on the device (downloaded once, runs offline) and switches the whole thing off.
import {
  closeOtherTabs,
  hideDayPanel,
  hideSidebar,
  openNote,
  vaultFile
} from '../graph-edit/ui.mjs'
import { NOTE } from './vault.mjs'

const BOARD = 'Fall planning'
const similar = (page) => page.locator('section[aria-label="Similar notes"]')
const aiSwitch = (page) =>
  page.locator('[data-settings-label="Enable AI Features"] [role="switch"]')

/** Every note embedded: the model downloads once per (fresh) profile, then the vault is indexed. */
async function waitForEmbeddings(page) {
  let last = -1
  let stable = 0
  for (let i = 0; i < 180 && stable < 3; i++) {
    const { embeddingCount } = await page.evaluate(() => window.api.settings.getAIModelStatus())
    stable = embeddingCount > 40 && embeddingCount === last ? stable + 1 : 0
    last = embeddingCount
    await page.waitForTimeout(1000)
  }
  if (stable < 3) throw new Error(`embeddings did not settle (${last} notes)`)
}

/** Settings slides in: a target is clicked once its box holds still for two polls. */
async function steady(locator) {
  let prev = null
  for (let i = 0; i < 60; i++) {
    const b = await locator.boundingBox()
    if (b && prev && Math.abs(b.x - prev.x) < 0.5 && Math.abs(b.y - prev.y) < 0.5) return
    prev = b
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('target kept moving')
}

export async function setup({ page }) {
  await waitForEmbeddings(page)
  await hideDayPanel(page)
  const section = page.getByRole('button', { name: /^Canvases section, collapsed/ })
  if (await section.count()) {
    await section.first().click()
    await page.waitForTimeout(500)
  }
  await page.getByText(BOARD, { exact: true }).first().click()
  await page.waitForTimeout(2000)
  await closeOtherTabs(page, BOARD)
  await hideSidebar(page)
  // Fit the board; Shift+1 needs the board focused, and the corner is clear of cards.
  await page.mouse.click(1480, 180)
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(1000)
  await openNote(page, NOTE)
  await similar(page).getByText('5 similar notes').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add tag travel' }).waitFor()
  await page.mouse.move(1000, 520)
  await page.waitForTimeout(800)
}

export const scenes = {
  async hook({ rec, page, zoom, at }) {
    zoom(800, 455, 1.2)
    const s = await similar(page).boundingBox()
    await at(0.8)
    await rec.glide(s.x + 230, s.y + 6, 1400)
  },
  async similar({ rec, page, zoom, sleep, at }) {
    const s = await similar(page).boundingBox()
    zoom(s.x + 140, s.y + s.height / 2, 2.2)
    await sleep(600)
    const rows = similar(page).getByRole('button').filter({ hasNotText: 'similar notes' })
    for (const i of [0, 1, 2]) {
      const r = await rows.nth(i).boundingBox()
      await rec.glide(r.x + 150, r.y + r.height / 2, 520)
      await sleep(180)
    }
    await at(4.2)
  },
  async tag({ rec, page, zoom, sleep, at }) {
    const chip = page.getByRole('button', { name: 'Add tag travel' })
    const c = await chip.boundingBox()
    zoom(c.x + 60, c.y + 30, 2.2)
    await sleep(700)
    await rec.click(chip)
    await page.getByRole('list', { name: 'Tags' }).getByText('travel').waitFor()
    await sleep(300)
    await rec.glide(c.x + 150, c.y + 70, 600)
    await at(3.6)
  },
  async groups({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await rec.click(page.getByRole('tab', { name: BOARD }))
    const button = page.getByRole('button', { name: 'Suggest groups' })
    await button.waitFor()
    await sleep(250)
    await rec.click(button)
    const dialog = page.getByRole('dialog')
    const create = dialog.getByRole('button', { name: /^Create 2 frames/ })
    await create.waitFor()
    const d = await dialog.boundingBox()
    zoom(d.x + d.width / 2, d.y + d.height / 2, 2.0)
    await sleep(1700)
    await rec.click(create)
    await dialog.waitFor({ state: 'hidden' })
    unzoom()
    // Off camera: the model sleeps after 30 s idle and Settings would then read "Not downloaded"
    // (its label for any unloaded model); load it from the on-disk cache, as any embedding would.
    await page.evaluate(() => window.api.settings.loadAIModel())
    await sleep(700)
    // Toward the rail's Settings button, over the new frames.
    await rec.glide(110, 800, 1100)
    await at(6.7)
  },
  async offline({ rec, page, zoom, sleep, at }) {
    // Settings opens on Account; AI & Agents is one click down its list.
    await rec.click(page.getByRole('button', { name: 'Settings' }).first(), { pause: 80 })
    const nav = page.getByRole('button', { name: 'AI & Agents' })
    await steady(nav)
    await rec.click(nav, { pause: 80 })
    const row = page.getByTestId('embedding-model-row')
    await row.getByText('Loaded').waitFor()
    const r = await row.boundingBox()
    zoom(r.x + r.width / 2 - 30, r.y + 4, 2.3)
    await sleep(700)
    const hint = page.getByText('Downloaded once, run offline')
    const h = await hint.boundingBox()
    await rec.glide(h.x + h.width + 14, h.y + h.height + 8, 600)
    await sleep(700)
    const loaded = await row.getByText('Loaded').boundingBox()
    await rec.glide(loaded.x + loaded.width / 2, loaded.y + loaded.height + 12, 600)
    await at(4.3)
  },
  async off({ rec, page, zoom, sleep, at }) {
    const r = await page.getByTestId('embedding-model-row').boundingBox()
    zoom(r.x + r.width / 2, r.y - 50, 2.0)
    await sleep(500)
    await rec.click(aiSwitch(page))
    await page.getByTestId('embedding-model-row').waitFor({ state: 'detached' })
    await sleep(300)
    const s = await aiSwitch(page).boundingBox()
    await rec.glide(s.x - 40, s.y + 70, 700)
    await at(3.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the note got the travel tag',
    () =>
      /^tags:\n(\s+- .*\n)*\s+- travel$/m.test(vaultFile(`Lisbon/${NOTE}.md`))
        ? null
        : 'no travel tag'
  ],
  [
    'the board has two frames',
    () => {
      const { elements } = JSON.parse(vaultFile(`canvases/${BOARD}.excalidraw`))
      const frames = elements.filter((e) => e.type === 'frame' && !e.isDeleted).map((e) => e.name)
      return frames.length === 2 ? null : `frames: ${frames.join(', ')}`
    }
  ],
  [
    'AI features are off',
    (q) =>
      q(`SELECT value FROM settings WHERE key = 'ai.enabled'`)[0]?.value === 'false'
        ? null
        : 'still on'
  ]
]
