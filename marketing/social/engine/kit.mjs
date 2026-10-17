// Moves most social clips share. Off-camera helpers (setup) take `page`; on-camera ones take the
// scene ctx and move the fake cursor like a person would. Selectors are from v2026-10-15.

/** Off camera: open a note, journal day or anything the search box finds, by its title. */
export async function open(page, title) {
  await page.getByRole('button', { name: 'Search or jump to…' }).click()
  await page.waitForTimeout(300)
  await page.keyboard.type(title)
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
}

/** Off camera: close every tab but the one named `keep`. */
export async function closeOtherTabs(page, keep) {
  // Only the window's tab strip: pages have tabs of their own (Inbox: Archived, Insights).
  const strip = () => page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')
  for (let i = 0; i < 12; i++) {
    const tabs = await strip().evaluateAll((els) => els.map((e) => e.textContent.trim()))
    const other = tabs.findIndex((t) => t && t !== keep)
    if (other < 0) return
    const tab = strip().nth(other)
    await tab.click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
  }
}

/** Off camera: expand a sidebar section ("Collections", "Projects", "Tags", ...). */
export async function expandSection(page, name) {
  const b = page.getByRole('button', { name: new RegExp(`^${name} section, collapsed`) })
  if (await b.count()) {
    await b.first().click()
    await page.waitForTimeout(400)
  }
}

/** Off camera: expand a folder in the sidebar (Collections must be expanded). No-op if open. */
export async function expandFolder(page, name) {
  const matches = page.getByText(name, { exact: true })
  let row
  for (let i = 0; i < (await matches.count()); i++) {
    const b = await matches.nth(i).boundingBox()
    if (b && b.x < 300) row = b
  }
  if (!row) throw new Error(`No folder "${name}" in the sidebar`)
  const buttons = page.getByRole('button', { name: 'Expand folder' })
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = await buttons.nth(i).boundingBox()
    if (b && Math.abs(b.y + b.height / 2 - (row.y + row.height / 2)) < 10) {
      await buttons.nth(i).click()
      await page.waitForTimeout(400)
      return
    }
  }
}

/** Off camera: park the pointer where it hides nothing and wait for the UI to settle. */
export async function settle(page, x = 800, y = 620) {
  await page.mouse.move(x, y)
  await page.waitForTimeout(700)
}

/**
 * On camera: wheel-scroll smoothly (pointer over the scroll area) until `locator`'s top is at
 * `top` (CSS px). Returns the locator's box after the scroll.
 */
export async function scrollTo(
  { rec, page, sleep },
  locator,
  top = 300,
  { x = 790, y = 560 } = {}
) {
  await rec.glide(x, y, 450)
  for (let i = 0; i < 40; i++) {
    const b = await locator.boundingBox()
    const left = b.y - top
    if (Math.abs(left) < 12) break
    await page.mouse.wheel(0, Math.sign(left) * Math.min(60, Math.abs(left)))
    await sleep(40)
  }
  await sleep(250)
  return locator.boundingBox()
}

/** On camera: click a control that pops up a search field, then type into that field once it has focus. */
export async function clickThenType({ rec, page, sleep }, target, field, text, { cps = 10 } = {}) {
  await rec.click(target)
  await field.waitFor()
  await page.waitForFunction((el) => el === document.activeElement, await field.elementHandle())
  await sleep(250)
  await rec.type(text, { cps })
}
