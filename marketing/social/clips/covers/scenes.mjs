// Covers and icons: Lisbon Itinerary gets the Lisbon photo already in the vault (filed with Lisbon
// Ideas) from the cover picker's From note tab; Reposition, a drag sets the focus, two zoom steps
// and the band's bottom edge dragged down; then the title row's icon is swapped from the map to a
// tram. The note starts with an icon (set off camera from the sidebar): the title row shows the
// icon button only on a note that has one.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const NOTE = 'Lisbon Itinerary'

/** The sidebar row named `name` (the same text can show in the main pane too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Lisbon')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  // The note's current icon, a map, from the sidebar's Set Icon.
  await (await sidebarRow(page, NOTE)).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Set Icon' }).click()
  await page.getByPlaceholder('Search', { exact: true }).fill('world map')
  await page.locator('em-emoji-picker').getByRole('button', { name: '🗺️', exact: true }).click()
  await page.getByTestId('note-title-icon').waitFor()
  // Open the cover picker once off camera, so its From note thumbnails are decoded before the
  // take (full-size photos; on a cold start the tiles are grey for a second).
  await page.getByTestId('note-metadata').hover()
  await page.getByTestId('ghost-add-cover').click()
  await page.getByLabel('Note cover').getByRole('tab', { name: 'From note' }).click()
  await tilesLoaded(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  await settle(page, 1100, 700)
}

async function tilesLoaded(page) {
  const imgs = page.getByLabel('Note cover').locator('img')
  await imgs.first().waitFor()
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[aria-label="Note cover"] img')].every(
        (img) => img.complete && img.naturalWidth > 0
      ),
    null,
    { timeout: 20000 }
  )
}

const band = (page) => page.getByTestId('note-cover')

/** Press, glide, release: a drag the pointer capture of the band and its edge follow. */
async function drag({ rec, page, sleep }, from, ...to) {
  await rec.glide(from.x, from.y, 600)
  await sleep(250)
  await page.mouse.down()
  for (const p of to) await rec.glide(p.x, p.y, p.ms ?? 700)
  await sleep(120)
  await page.mouse.up()
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const t = await page.getByTestId('note-title-icon').boundingBox()
    await rec.glide(t.x + 380, t.y + 40, 1000)
    await rec.glide(t.x + 60, t.y + 150, 900)
  },
  async pick({ rec, page, zoom, unzoom, sleep }) {
    const add = page.getByTestId('ghost-add-cover')
    await page.getByTestId('note-metadata').hover()
    await add.waitFor()
    const a = await add.boundingBox()
    zoom(a.x + 330, a.y + 160, 1.6)
    await rec.click(add)
    const picker = page.getByLabel('Note cover')
    await picker.waitFor()
    await sleep(400)
    await rec.click(picker.getByRole('tab', { name: 'From note' }))
    const tile = picker.getByRole('button', { name: /Lisbon Ideas/ }).first()
    await tile.waitFor()
    await tilesLoaded(page)
    await sleep(700)
    await rec.click(tile)
    await band(page).waitFor()
    await sleep(300)
    unzoom()
    await rec.glide(1100, 330, 900)
  },
  async focus(ctx) {
    const { rec, page, zoom, sleep } = ctx
    const b = await band(page).boundingBox()
    await rec.glide(b.x + b.width - 120, b.y + b.height / 2, 600)
    const repo = page.getByRole('button', { name: 'Reposition' })
    await repo.waitFor()
    await rec.click(repo)
    await page.getByTestId('note-cover-reposition-hint').waitFor()
    zoom(b.x + b.width / 2 + 120, b.y + b.height / 2 + 60, 1.5)
    await sleep(500)
    // Down toward the street, then back up to the harbor: the boat, the bougainvillea, the
    // rooftops (48%, which keeps that framing once the band is zoomed and taller).
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    await drag(
      ctx,
      { x: cx, y: cy },
      { x: cx, y: b.y + b.height * 0.72, ms: 700 },
      { x: cx, y: b.y + b.height * 0.48, ms: 900 }
    )
    await sleep(300)
    await rec.glide(cx + 160, cy + 140, 600)
  },
  async taller(ctx) {
    const { rec, page, zoom, sleep } = ctx
    const zin = page.getByTestId('note-cover-zoom-in')
    await rec.click(zin)
    await sleep(450)
    await rec.click(zin)
    await sleep(500)
    const h = await page.getByTestId('note-cover-resize-handle').boundingBox()
    const x = h.x + h.width / 2 + 120
    zoom(x, h.y - 20, 1.5)
    await drag(ctx, { x, y: h.y + 4 }, { x, y: h.y + 96, ms: 1100 })
    await sleep(350)
    await rec.click(page.getByTestId('note-cover-reposition-save'))
    await sleep(300)
  },
  async icon({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(400)
    const icon = page.getByTestId('note-title-icon')
    const i = await icon.boundingBox()
    await rec.click(icon)
    const search = page.getByPlaceholder('Search', { exact: true })
    await search.waitFor()
    const s = await search.boundingBox()
    zoom(s.x + 260, s.y + 20, 1.7)
    await sleep(500)
    await rec.click(search)
    await sleep(250)
    await rec.type('tram', { cps: 9 })
    const tram = page.locator('em-emoji-picker').getByRole('button', { name: '🚋', exact: true })
    await tram.waitFor()
    await sleep(450)
    await rec.click(tram)
    await sleep(350)
    zoom(i.x + 260, i.y + 10, 1.8)
    await rec.glide(i.x + 120, i.y + 110, 800)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

const file = () => {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, 'Lisbon', `${NOTE}.md`), 'utf8')
}

export const checks = [
  [
    'the cover is the vault photo, by path',
    () => (/\ncover: \.\.\/attachments\/[^\n]+lisbon-rooftops\.jpg\n/.test(file()) ? null : file())
  ],
  [
    'focus, zoom and a taller band are saved',
    () =>
      /coverFocus: \d+/.test(file()) &&
      /coverZoom: 1\.2/.test(file()) &&
      Number(file().match(/coverHeight: (\d+)/)?.[1]) > 250
        ? null
        : file()
  ]
]
