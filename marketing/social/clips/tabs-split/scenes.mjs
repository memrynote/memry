// Tabs and split view: two notes in two tabs, hovering the inactive tab previews its note without
// switching, then the Homepage Ideas tab is dragged to the right edge of the window ("Split Right")
// and the brief sits on the left with the ideas beside it.
const BRIEF = 'Website Redesign Brief'
const IDEAS = 'Homepage Ideas'

async function openFromSearch(page, title) {
  await page.getByRole('button', { name: 'Search or jump to…' }).click()
  await page.waitForTimeout(300)
  await page.keyboard.type(title)
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
}

export async function setup({ page }) {
  const _strip = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  await openFromSearch(page, BRIEF)
  await page.getByRole('button', { name: 'New Tab' }).click()
  await page.waitForTimeout(500)
  await openFromSearch(page, IDEAS)
  // Home is the only other tab.
  await page.getByTestId('nav-home').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(500)
  await page.getByRole('tab', { name: IDEAS }).click()
  if (await page.locator('[aria-label="Resize Day Panel"]').count()) {
    await page.mouse.move(800, 600)
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click()
  await page.waitForTimeout(600)
  await page.mouse.move(800, 600)
}

const tab = (page, title) => page.getByRole('tab', { name: title })

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    await rec.glide(900, 400, 1000)
    const c = await rec.center(tab(page, IDEAS))
    await rec.glide(c.x + 30, c.y + 4, 1000)
  },
  async hover({ rec, page, zoom, sleep: _sleep, at }) {
    zoom(560, 120, 1.7)
    const c = await rec.center(tab(page, BRIEF))
    await rec.glide(c.x, c.y, 800)
    await page
      .locator('[data-tab-preview], [role="dialog"], [data-radix-popper-content-wrapper]')
      .first()
      .waitFor()
      .catch(() => {})
    await at(4.4)
  },
  async drag({ rec, page, zoom, sleep, at }) {
    zoom(900, 280, 1.4)
    const c = await rec.center(tab(page, IDEAS))
    await rec.glide(c.x, c.y, 800)
    await sleep(300)
    rec.mark('drag')
    await page.mouse.down()
    await sleep(150)
    await page.mouse.move(c.x + 20, c.y + 30, { steps: 4 })
    await page.mouse.move(1000, 300, { steps: 25 })
    await page.mouse.move(1240, 460, { steps: 25 })
    await page.getByText('Split Right').waitFor()
    await sleep(900)
    await page.mouse.up()
    await at(5.8)
  },
  async split({ rec, page: _page, unzoom, at }) {
    unzoom()
    await rec.glide(1000, 560, 900)
    await at(5.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
