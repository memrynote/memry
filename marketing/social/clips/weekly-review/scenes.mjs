// A weekly review from the calendar: the month view with the overdue tasks sitting on the days they
// were due, the Day Panel counting them, a task's card saying how many days overdue it is, then one
// click on Tomorrow moves it and one click on Complete finishes another.
export async function setup({ page }) {
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click()
  await page.waitForTimeout(1200)
  const tab = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  for (let i = 0; i < 6; i++) {
    const tabs = await tab.evaluateAll((els) => els.map((e) => e.textContent.trim()))
    const other = tabs.findIndex((t) => !/Calendar/.test(t))
    if (other < 0) break
    await tab.nth(other).click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
  await page.getByRole('button', { name: 'Month', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.mouse.move(700, 700)
}

const chip = (page, text) => page.getByText(text).first()

export const scenes = {
  async hook({ rec, page: _page, at }) {
    await at(0.4)
    await rec.glide(1350, 520, 1200)
    await rec.glide(1500, 590, 900)
  },
  async overdue({ rec, page, zoom, at }) {
    zoom(1400, 560, 1.8)
    await at(0.9)
    const b = await rec.center(page.getByText('4 overdue'))
    await rec.glide(b.x - 4, b.y + 2, 800)
  },
  async move({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(500)
    const c = await rec.center(chip(page, /Chase the/))
    zoom(c.x + 220, c.y + 40, 1.8)
    await rec.click(chip(page, /Chase the/))
    await page.getByText(/6 days overdue/).waitFor()
    await sleep(1700)
    await rec.click(page.getByRole('button', { name: 'Tomorrow', exact: true }))
    await at(6.4)
  },
  async done({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(500)
    const c = await rec.center(chip(page, /Reply to the/))
    zoom(c.x + 200, c.y + 40, 1.8)
    await rec.click(chip(page, /Reply to the/))
    await page.getByText(/3 days overdue/).waitFor()
    await sleep(1500)
    await rec.click(page.getByText('Complete', { exact: true }).last())
    await at(5.6)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
