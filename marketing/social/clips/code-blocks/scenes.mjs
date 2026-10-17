// Code blocks: a CSS snippet pasted into a new ``` block arrives as plain text; the toolbar's
// language picker sets CSS and the colors come in; Settings > Appearance > Dark, and back in the
// note the block has switched to the dark palette with the app; the copy button copies it.
// The picker is a native <select>. Its open list is drawn by the OS and never reaches the
// screencast, and clicking it would open that list, so the pointer rests on it while the option is
// selected (the select's own change event, the same path a pick takes).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const INTRO = "The workshop's decisions, as CSS for the build:"
const SNIPPET = `:root {
  --ink: #1d1813;
  --clay: #c4561d;
  --font-heading: "Fraunces", serif;
  --font-body: system-ui, sans-serif;
}`

export async function setup({ page }) {
  await open(page, 'Brand workshop with Lea')
  await closeOtherTabs(page, 'Brand workshop with Lea')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  await page.evaluate((text) => navigator.clipboard.writeText(text), SNIPPET)
  await settle(page)
}

const block = (page) => page.locator('[data-content-type="codeBlock"]').first()

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const b = await page.getByText(INTRO).boundingBox()
    await rec.glide(b.x + b.width + 140, b.y + 110, 1000)
    await rec.glide(b.x + b.width + 40, b.y + b.height / 2 + 4, 900)
  },
  async paste({ rec, page, zoom, sleep }) {
    const b = await page.getByText(INTRO).boundingBox()
    zoom(950, b.y + 190, 1.6)
    await rec.click(page.getByText(INTRO), { dx: b.width / 2 + 30 })
    await sleep(350)
    await rec.key('Enter')
    await sleep(250)
    await rec.type('``` ', { cps: 9 })
    await block(page).waitFor()
    await sleep(500)
    await rec.key('Meta+v')
    await page.getByText('--font-heading').waitFor()
    const c = await block(page).boundingBox()
    await rec.glide(c.x + c.width - 300, c.y + c.height - 30, 900)
  },
  async language({ rec, page, zoomOn, sleep }) {
    await zoomOn(block(page), 1.7, { dx: 60, dy: 40 })
    const picker = page.getByLabel('Language')
    const c = await rec.center(picker)
    await rec.glide(c.x - 20, c.y + 2, 800)
    await sleep(450)
    await picker.selectOption('css')
    await sleep(400)
    await rec.glide(c.x - 120, c.y + 90, 900)
  },
  async theme({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(450)
    await rec.click(page.getByRole('button', { name: 'Settings', exact: true }))
    await page.getByText('Appearance', { exact: true }).first().waitFor()
    await sleep(500)
    await rec.click(page.getByText('Appearance', { exact: true }).first())
    const modes = page.getByRole('group', { name: 'Color mode' })
    await modes.waitFor()
    const g = await modes.boundingBox()
    zoom(g.x + g.width / 2 - 120, g.y + 60, 1.8)
    await sleep(900)
    await rec.click(modes.getByRole('button', { name: 'Dark' }))
    await sleep(500)
    await rec.glide(g.x + g.width - 40, g.y + g.height + 70, 800)
  },
  async dark({ rec, page, zoomOn, unzoom, sleep }) {
    unzoom()
    await sleep(450)
    await rec.click(page.getByRole('button', { name: 'Back to app' }))
    await block(page).waitFor()
    await sleep(300)
    await zoomOn(block(page), 1.7, { dx: 60, dy: 40 })
    const c = await block(page).boundingBox()
    await rec.glide(c.x + c.width / 2 + 40, c.y + c.height / 2, 1000)
  },
  async copy({ rec, page, zoom, sleep }) {
    // Close on the toolbar, so the check that replaces the copy icon reads.
    const b = await block(page).boundingBox()
    zoom(b.x + 380, b.y + 100, 2.0)
    await sleep(600)
    await rec.click(page.getByRole('button', { name: 'Copy code' }))
    await page.getByRole('button', { name: 'Copied' }).waitFor()
    // Off the button at once: the check only shows for 1.5 s.
    const c = await rec.center(page.getByRole('button', { name: 'Copied' }))
    await rec.glide(c.x - 90, c.y + 70, 380)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

// The take's own vault copy (agent-app's state file in this slot's temp dir).
const note = () => {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, 'Meetings/Brand workshop with Lea.md'), 'utf8')
}

export const checks = [
  [
    'the note file holds a ```css fence with the snippet',
    () => (/```css\n:root \{\n {2}--ink: #1d1813;/.test(note()) ? null : note().slice(-400))
  ]
]
