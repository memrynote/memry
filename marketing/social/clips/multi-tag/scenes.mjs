// Multi-tag: open the client tag, Cmd-click meeting to narrow the notes to the ones carrying both
// (the filter bar reads "Matching all: client, meeting"), then Save search under a name and find it
// again in the Saved searches menu.
import { closeOtherTabs, expandSection } from '../../engine/kit.mjs'

export async function setup({ page }) {
  await closeOtherTabs(page, 'Home').catch(() => {})
  // The day panel only crowds the list.
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await expandSection(page, 'Tags')
  await page.mouse.move(900, 700)
  await page.waitForTimeout(500)
}

const tag = (page, name) => page.getByRole('button', { name, exact: true })
const NAME = 'Client meetings'

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const c = await rec.center(tag(page, 'client'))
    await rec.glide(c.x + 200, c.y + 120, 900)
    await rec.glide(c.x + 30, c.y, 1100)
  },
  async open({ rec, page, zoom, sleep, at }) {
    zoom(300, 300, 1.5)
    await rec.click(tag(page, 'client'))
    await page
      .getByText('3 items')
      .or(page.getByText(/\d+ items/))
      .first()
      .waitFor()
    await at(4.0)
  },
  async narrow({ rec, page, zoom, sleep, at }) {
    const c = await rec.center(tag(page, 'meeting'))
    await rec.glide(c.x, c.y, 700)
    await sleep(300)
    rec.mark('click')
    await page.keyboard.down('Meta')
    await page.mouse.down()
    await sleep(70)
    await page.mouse.up()
    await page.keyboard.up('Meta')
    await page.getByText('Matching all:').waitFor()
    await sleep(500)
    zoom(520, 170, 1.7)
    await at(5.2)
  },
  async save({ rec, page, zoom, sleep, at }) {
    zoom(560, 200, 1.7)
    await rec.click(page.getByRole('button', { name: 'Save search' }))
    const input = page.getByPlaceholder('e.g. Work meetings')
    await input.waitFor()
    await sleep(500)
    await rec.type(NAME, { cps: 11 })
    await sleep(400)
    await rec.click(page.getByRole('button', { name: 'Save', exact: true }))
    await page.getByTestId('tag-and-filter-saved-menu').waitFor()
    await at(6.2)
  },
  async reopen({ rec, page, zoom, unzoom, sleep, at }) {
    await rec.click(page.getByTestId('tag-and-filter-clear'))
    await page.getByText('Matching all:').waitFor({ state: 'hidden' })
    await sleep(900)
    await rec.click(page.getByTestId('tag-and-filter-saved-menu'))
    const item = page.getByRole('menuitem', { name: new RegExp(NAME) })
    await item.waitFor()
    await sleep(700)
    await rec.click(item)
    await page.getByText('Matching all:').waitFor()
    unzoom()
    await sleep(700)
    zoom(560, 170, 1.7)
    await at(7.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
