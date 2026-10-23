// Bookmarks: a note, a folder and a tag bookmarked from their right-click menus; they collect in
// the sidebar's Bookmarks section and in Home's Bookmarks widget (empty before, "No bookmarks yet").
import { expandFolder, expandSection, settle } from '../../engine/kit.mjs'

const _side = (page, text) =>
  page.locator('nav, aside, [data-sidebar]').getByText(text, { exact: true }).first()

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Home' }).first().click()
  await page.waitForTimeout(1200)
  await expandSection(page, 'Collections')
  await expandSection(page, 'Tags')
  await expandSection(page, 'Bookmarks')
  await expandFolder(page, 'Ideas')
  await settle(page, 1000, 700)
}

/** Right-click `target` like a person, then choose Bookmark. */
async function bookmark({ rec, page, sleep }, target) {
  const c = await rec.center(target)
  await rec.glide(c.x, c.y, 800)
  await sleep(200)
  rec.mark('click')
  await page.mouse.click(c.x, c.y, { button: 'right' })
  const item = page.getByRole('menuitem', { name: /^Bookmark$/ })
  await item.waitFor()
  await sleep(500)
  await rec.click(item)
  await sleep(500)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(page.getByText('Ideas backlog', { exact: true }).first())
    await rec.glide(c.x, c.y, 1800)
  },
  async note(ctx) {
    ctx.zoom(200, 230, 1.6)
    await ctx.sleep(500)
    await bookmark(ctx, ctx.page.getByText('Ideas backlog', { exact: true }).first())
    await ctx.page
      .locator('[data-testid="bookmark-item"], button')
      .filter({ hasText: 'Ideas backlog' })
      .first()
      .waitFor()
    await ctx.at(4.0)
  },
  async folder(ctx) {
    ctx.zoom(200, 270, 1.5)
    await ctx.sleep(400)
    await bookmark(ctx, ctx.page.getByText('Ideas', { exact: true }).first())
    await ctx.at(3.6)
  },
  async tag(ctx) {
    // Collections folds away so the tags come up into view, clear of the caption.
    const head = ctx.page.getByRole('button', { name: /^Collections section, expanded/ })
    await ctx.rec.click(head)
    await ctx.sleep(600)
    ctx.zoom(200, 330, 1.6)
    await ctx.sleep(500)
    await bookmark(ctx, ctx.page.getByText('meeting', { exact: true }).first())
    await ctx.at(3.6)
  },
  async home({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(500)
    const b = await rec.center(page.locator('[data-testid="bookmark-item"]').nth(1))
    zoom(430, 540, 1.5)
    await rec.glide(b.x, b.y, 900)
    await at(4.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
