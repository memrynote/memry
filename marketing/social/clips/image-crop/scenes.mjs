// Crop and resize: the Alfama viewpoint photo in Lisbon Ideas is cropped from its File actions
// menu to the palm and the river, then made smaller from its bottom corner. Crop… again shows the
// whole photo is still there, the crop only a frame over it. The checks compare the attachment on
// disk with the file that was added, byte for byte, and read the crop and width from the markdown.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeOtherTabs, expandFolder, expandSection, settle } from '../../engine/kit.mjs'

const ASSET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vault/assets/image-crop-miradouro.jpg'
)
// The palm, the river and the hills, as fractions of the picture.
const FROM = { x: 0.04, y: 0.28 }
const TO = { x: 0.58, y: 0.84 }

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
  // From the sidebar: search ranks Lisbon Itinerary (which links here) above Lisbon Ideas.
  await page.getByRole('button', { name: 'Search or jump to…' }).waitFor()
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Lisbon')
  await (await sidebarRow(page, 'Lisbon Ideas')).click()
  await page.getByRole('heading', { name: 'See' }).waitFor()
  await closeOtherTabs(page, 'Lisbon Ideas')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  // The See list at the top, the photo whole below it.
  await page.mouse.move(950, 500)
  for (let i = 0; i < 30; i++) {
    const s = await page.getByRole('heading', { name: 'See' }).boundingBox()
    if (s.y < 180) break
    await page.mouse.wheel(0, Math.min(60, s.y - 170))
    await page.waitForTimeout(40)
  }
  await page
    .locator('.bn-editor img')
    .first()
    .evaluate((img) => img.decode())
  await settle(page, 1450, 760)
}

const image = (page) => page.locator('.bn-editor img').first()
const stage = (page) => page.getByTestId('image-crop-stage')

/** Press, glide, release. */
async function drag({ rec, page, sleep }, from, to, ms) {
  await rec.glide(from.x, from.y, 600)
  await sleep(250)
  await page.mouse.down()
  await rec.glide(to.x, to.y, ms)
  await sleep(120)
  await page.mouse.up()
}

/** Hover the photo, open its File actions menu, pick Crop…, wait for the dialog's picture. */
async function openCrop({ rec, page, sleep }) {
  // The photo's frame is the parent of its <img> (the img keeps the full size under the crop).
  const f = await image(page).evaluate((img) => {
    const r = img.parentElement.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  await rec.glide(f.x + f.width - 60, f.y + 50, 700)
  const menu = page.getByTestId('attachment-menu-button')
  await menu.waitFor()
  await sleep(300)
  // The button sits at the corner of the uncropped box, outside the cropped frame, and hides
  // when the pointer is not over the photo: open it from the keyboard.
  await menu.focus()
  await page.keyboard.press('Enter')
  const item = page.getByRole('menuitem', { name: 'Crop…' })
  await item.waitFor()
  await sleep(450)
  await rec.click(item)
  await stage(page)
    .locator('img')
    .evaluate((img) => img.decode())
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const i = await image(page).boundingBox()
    await rec.glide(i.x + i.width / 2 + 120, i.y + i.height / 2, 1000)
    await rec.glide(i.x + i.width - 90, i.y + 90, 900)
  },
  async crop(ctx) {
    const { rec, page, zoom, sleep } = ctx
    const i = await image(page).boundingBox()
    zoom(i.x + i.width - 150, i.y + 110, 1.6)
    await openCrop(ctx)
    const s = await stage(page).boundingBox()
    zoom(s.x + s.width / 2, s.y + s.height / 2 + 30, 1.5)
    await sleep(700)
    const at = (p) => ({ x: s.x + s.width * p.x, y: s.y + s.height * p.y })
    await drag(ctx, at(FROM), at(TO), 1300)
    await sleep(300)
    await rec.glide(at(TO).x + 90, at(TO).y + 40, 600)
  },
  async cropped({ rec, page, zoom, unzoom, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Crop', exact: true }))
    await page.getByTestId('image-crop-dialog').waitFor({ state: 'hidden' })
    unzoom()
    await sleep(500)
    const i = await image(page).evaluate((img) => {
      const r = img.parentElement.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    zoom(i.x + i.width / 2, i.y + i.height / 2 + 30, 1.5)
    await rec.glide(i.x + i.width + 60, i.y + i.height / 2, 900)
  },
  async resize(ctx) {
    const { page, sleep } = ctx
    const corner = page.locator('.memry-image-corner-handle[data-corner="bottom-end"]')
    const i = await image(page).evaluate((img) => {
      const r = img.parentElement.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    await ctx.rec.glide(i.x + i.width - 40, i.y + i.height - 40, 500)
    await corner.waitFor()
    const c = await ctx.rec.center(corner)
    await drag(ctx, c, { x: c.x - 250, y: c.y - 150 }, 1200)
    await sleep(300)
    await ctx.rec.glide(c.x - 120, c.y - 60, 600)
  },
  async whole(ctx) {
    const { rec, page, zoom, sleep } = ctx
    await openCrop(ctx)
    const s = await stage(page).boundingBox()
    zoom(s.x + s.width / 2, s.y + s.height / 2 + 30, 1.5)
    await rec.glide(s.x + s.width + 60, s.y + s.height / 2, 900)
    await sleep(1700)
    await rec.click(page.getByRole('button', { name: 'Cancel' }))
    await page.getByTestId('image-crop-dialog').waitFor({ state: 'hidden' })
  },
  async end({ unzoom }) {
    unzoom()
  }
}

const vault = () =>
  JSON.parse(fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8'))
    .vaultPath
const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex')
const note = () => fs.readFileSync(path.join(vault(), 'Lisbon/Lisbon Ideas.md'), 'utf8')

export const checks = [
  [
    'the markdown carries the crop and the new width',
    () => (/!\[miradouro\.jpg\|crop=[\d.,]+\|\d+\]/.test(note()) ? null : note().slice(-200))
  ],
  [
    'the attachment on disk is byte-identical to the photo that was added',
    () => {
      const dir = path.join(vault(), 'attachments')
      const files = fs
        .readdirSync(dir, { recursive: true })
        .filter((f) => String(f).endsWith('-miradouro.jpg'))
      if (files.length !== 1) return `found ${files.length} miradouro attachments`
      return md5(path.join(dir, String(files[0]))) === md5(ASSET) ? null : 'the attachment changed'
    }
  ]
]
