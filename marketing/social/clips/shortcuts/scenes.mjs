// Rebinding: Settings → Shortcuts lists the tab, split and zoom shortcuts; Split Right moves from
// Cmd+\ to Cmd+Shift+L by clicking its keys and pressing the new ones, then the new keys split the
// note from inside a sentence, with the caret in the editor.
import { closeOtherTabs, open } from '../../engine/kit.mjs'

const NOTE = 'Weekly sync with Sam'

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: 'Shortcuts' }).click()
  await page.waitForTimeout(900)
  // Rebinds persist in the app's settings: start from the defaults.
  const reset = page.getByText('Reset all to defaults')
  if (await reset.count()) {
    await reset.click()
    await page.waitForTimeout(600)
  }
  await page.getByPlaceholder('Search shortcuts...').fill('split')
  await page.waitForTimeout(700)
  await page.mouse.move(1100, 700)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    await rec.glide(1000, 560, 1100)
    const c = await rec.center(page.getByText('Split Right'))
    await rec.glide(c.x + 40, c.y + 4, 900)
  },
  async rebind({ rec, page, zoom, sleep, at }) {
    zoom(960, 440, 1.7)
    await sleep(600)
    await rec.click(page.getByTitle('Click to rebind').first())
    await page.getByText('Press shortcut…').waitFor()
    await sleep(900)
    rec.mark('key', { key: 'Meta+Shift+L' })
    await page.keyboard.press('Meta+Shift+KeyL')
    await page.getByText('Press shortcut…').waitFor({ state: 'hidden' })
    await at(6.2)
  },
  async use({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(300)

    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    await sleep(900)
    const line = page.getByText('Mobile nav: prototype both the menu and a bottom bar')
    const b = await line.boundingBox()
    zoom(800, b.y + 40, 1.4)
    await rec.click(line, { dx: b.width / 2 + 40 })
    await sleep(500)
    await rec.type(', then review', { cps: 12 })
    await sleep(700)
    await rec.key('Meta+Shift+KeyL')
    await sleep(900)
    unzoom()
    await at(8.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
