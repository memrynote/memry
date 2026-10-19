// The Book tag: Maya tags a new note "Ways of Seeing" as a book, its fields appear, she fills in
// the author and puts it on the Reading shelf; the view block on "Currently reading" (a view of #book
// filtered to Shelf == Reading, made in vault.mjs) then lists it. Setup adds the Book ready-made
// tag in the tag hub, the same click anyone does once, and opens the two notes so Back returns.
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

/** The sidebar row named `name` (the same text can show in the main pane too). */
async function sidebarRow(page, name) {
  const matches = page.getByText(name, { exact: true })
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) return matches.nth(i)
  }
  throw new Error(`No sidebar row "${name}"`)
}

const NOTE = 'Ways of Seeing'

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Open tag hub' }).click({ force: true })
  await page.waitForTimeout(900)
  await page
    .locator('div.items-start')
    .filter({ hasText: 'Author, Shelf' })
    .getByRole('button', { name: 'Add fields' })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add fields' }).click()
  await page.waitForTimeout(1400)
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Reading')
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  await settle(page)
}

/** The Book field named `name`: its value cell. */
const row = (page, name) =>
  page
    .getByRole('list', { name: 'book' })
    .locator(`div:has(> div > span[title="${name}"]) > [role=button]`)

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const c = await rec.center(page.getByRole('button', { name: 'Add tag', exact: true }))
    await rec.glide(c.x + 160, c.y + 110, 1000)
    await rec.glide(c.x, c.y, 900)
  },
  async tag({ rec, page, at, zoom, sleep }) {
    zoom(800, 300, 1.6)
    await rec.click(page.getByRole('button', { name: 'Add tag', exact: true }))
    await sleep(350)
    await rec.type('book', { cps: 9 })
    await sleep(350)
    await rec.key('Enter')
    await at(4.2)
  },
  async fill(ctx) {
    const { rec, page, sleep, at } = ctx
    await rec.click(row(page, 'Author').getByText('Empty'))
    await sleep(300)
    await rec.type('John Berger', { cps: 12 })
    await rec.key('Enter')
    await sleep(600)
    await rec.click(row(page, 'Shelf').getByText('Empty'))
    await sleep(500)
    await rec.click(page.getByRole('option', { name: 'Reading', exact: true }))
    await sleep(500)
    await at(6.6)
  },
  async list({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(400)
    await rec.click(await sidebarRow(page, 'Currently reading'))
    await page.locator('menu [role="button"]').filter({ hasText: NOTE }).waitFor()
    await sleep(300)
    const b = await page.getByTestId('view-block-source').boundingBox()
    zoom(b.x + 320, b.y + 70, 1.7)
    const r = await page.locator('menu [role="button"]').filter({ hasText: NOTE }).boundingBox()
    await rec.glide(r.x + 260, r.y + r.height / 2 + 6, 1000)
    await at(5.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
