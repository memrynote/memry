// Tags with fields: Lea Park becomes a Person, her Company points at Studio North, and Studio
// North's "Linked here" lists her back.
import {
  clickThenType,
  closeOtherTabs,
  expandFolder,
  expandSection,
  open,
  scrollTo,
  settle
} from '../../engine/kit.mjs'

export async function setup({ page }) {
  // The Person preset (it brings Company along for its Company field). Studio North is tagged
  // company in vault.mjs and never opened before Lea points at it, so its "Linked here" is fresh.
  await page.getByRole('button', { name: 'Open tag hub' }).click({ force: true })
  await page.waitForTimeout(900)
  await page
    .locator('div.items-start')
    .filter({ hasText: 'Company, Role, Email, Phone' })
    .getByRole('button', { name: 'Add' })
    .click()
  await page.waitForTimeout(900)
  await open(page, 'Lea Park')
  await closeOtherTabs(page, 'Lea Park')
  await expandSection(page, 'Collections')
  await expandFolder(page, 'People')
  await settle(page)
}

const fields = (page) => page.getByRole('list', { name: 'person' })

export const scenes = {
  async hook({ rec, page, at }) {
    // The cover/tag/property row shows while the pointer is over the title.
    await at(0.6)
    await rec.glide(760, 125, 1000)
    const c = await rec.center(page.getByRole('button', { name: 'Add tag', exact: true }))
    await rec.glide(c.x, c.y, 900)
  },
  async tag({ rec, page, at, zoom, sleep }) {
    zoom(800, 300, 1.6)
    await rec.click(page.getByRole('button', { name: 'Add tag', exact: true }))
    await sleep(350)
    await rec.type('person', { cps: 9 })
    await sleep(350)
    await rec.key('Enter')
    await at(4.2)
  },
  async fill(ctx) {
    const { rec, page, sleep } = ctx
    await rec.click(fields(page).getByRole('button', { name: 'Empty' }).first())
    await sleep(300)
    await rec.type('Marketing lead', { cps: 13 })
    await rec.key('Enter')
    await sleep(600)
    await clickThenType(
      ctx,
      page.getByRole('button', { name: 'Add relation' }).last(),
      page.getByPlaceholder(/Search company/i),
      'Stud'
    )
    await page.getByRole('option', { name: 'Studio North' }).waitFor()
    await sleep(500)
    await rec.key('Enter')
    await sleep(400)
    await rec.key('Escape')
  },
  async linked(ctx) {
    const { rec, page, zoom, unzoom, sleep, at } = ctx
    unzoom()
    await sleep(400)
    await rec.click(fields(page).getByText('Studio North'))
    await sleep(1000)
    const block = page.getByRole('heading', { name: 'Linked here' }).locator('..')
    const b = await scrollTo(ctx, block, 200)
    zoom(b.x + b.width / 2, b.y + 125, 1.9)
    await rec.glide(1060, 400, 900)
    await at(5.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
