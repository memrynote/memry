// Color themes: Settings → Appearance in dark mode, three themes picked in a row from the
// "Memrynote themes" list (each repaints the whole app), then back to the Studio North folder
// view, whose layout goes from table to gallery.
import { closeOtherTabs, expandSection, settle } from '../../engine/kit.mjs'

const THEMES = ['Dracula', 'Everforest', 'Night Owl']

/** The sidebar row named `name`. */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

export async function setup({ page }) {
  // Behind the settings: Studio North's folder view, in its table layout, without the day panel.
  await expandSection(page, 'Collections')
  const folder = await sidebarRow(page, 'Studio North')
  await folder.hover()
  await page.waitForTimeout(300)
  const fb = await folder.boundingBox()
  const views = page.getByRole('button', { name: 'Open folder view' })
  for (let i = 0; i < (await views.count()); i++) {
    const b = await views.nth(i).boundingBox()
    if (b && Math.abs(b.y + b.height / 2 - (fb.y + fb.height / 2)) < 10) {
      await views.nth(i).click({ force: true })
      break
    }
  }
  await page.waitForTimeout(1200)
  await closeOtherTabs(page, 'Studio North')
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  // Settings → Appearance, in dark mode, where the themes differ most.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.waitForTimeout(900)
  await page.getByText('Appearance', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.waitForTimeout(700)
  await settle(page, 900, 640)
}

const trigger = (page) => page.getByRole('button', { name: 'Theme', exact: true })

/** Theme dropdown → "Memrynote themes" → `name`, moving like a person through the submenu. */
async function pickTheme({ rec, page, sleep }, name) {
  await rec.click(trigger(page))
  const sub = page.getByRole('menuitem', { name: /Memrynote themes/ })
  await sub.waitFor()
  await sleep(300)
  const s = await rec.center(sub)
  await rec.glide(s.x + 30, s.y, 450)
  const item = page.getByRole('menuitem', { name: new RegExp(`${name}$`) })
  await item.waitFor()
  await sleep(250)
  // Straight across into the submenu's first row, then down to the theme.
  const first = await page.getByRole('menuitem', { name: /Ayu$/ }).boundingBox()
  await rec.glide(first.x + 50, s.y, 350)
  await rec.click(item, { dx: -50 })
  await trigger(page).filter({ hasText: name }).waitFor()
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(trigger(page))
    await rec.glide(c.x - 160, c.y + 140, 1100)
    await rec.glide(c.x - 20, c.y + 40, 900)
  },
  async pick(ctx) {
    const { rec, zoom, sleep, at } = ctx
    zoom(1180, 470, 1.5)
    await sleep(500)
    await pickTheme(ctx, THEMES[0])
    await sleep(300)
    await rec.glide(1060, 600, 700)
    await at(5.6)
  },
  async more(ctx) {
    const { rec, sleep, at } = ctx
    await pickTheme(ctx, THEMES[1])
    await sleep(300)
    await rec.glide(1060, 600, 600)
    await at(3.6)
    await pickTheme(ctx, THEMES[2])
    await sleep(300)
    await rec.glide(1060, 600, 600)
    await at(7.0)
  },
  async layout({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(400)
    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    const layouts = page.getByRole('group', { name: 'Layout' })
    await layouts.waitFor()
    await sleep(500)
    // One frame for the toggle, the table's titles and the gallery that replaces them.
    const t = await layouts.boundingBox()
    zoom(t.x + t.width - 535, 300, 1.5)
    await sleep(700)
    await rec.click(layouts.getByRole('button', { name: 'Gallery' }))
    await sleep(500)
    await rec.glide(t.x - 150, 420, 800)
    await at(5.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
