// Find in page paints its matches through the CSS Custom Highlight API (#3531 14j-2a). The pixel
// check samples the current match's fill, `::highlight(find-current)` in main.css, which differs
// per theme, so the spec pins the light theme first: the e2e app starts on `system`.
import { createNote, openFromSidebar, vaultOpen, NOTE_EDITOR } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

/** Share of the pixels of `word`'s box in a window screenshot that show the current-match fill. */
async function currentMatchShare(page: Page, word: string): Promise<number> {
  const shot = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ({ png, text }: { png: string; text: string }) => {
      const root = document.querySelector('[aria-label="Rich text editor"]')
      if (!root) throw new Error('no editor')
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let box: DOMRect | null = null
      while (!box && walker.nextNode()) {
        const node = walker.currentNode as Text
        const at = node.data.indexOf(text)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + text.length)
        box = range.getBoundingClientRect()
      }
      if (!box) throw new Error(`no "${text}" in the editor`)
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const scale = image.width / window.innerWidth
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.drawImage(image, 0, 0)
      const x = Math.ceil(box.left * scale)
      const y = Math.ceil(box.top * scale)
      const width = Math.floor(box.width * scale)
      const height = Math.floor(box.height * scale)
      const { data } = context.getImageData(x, y, width, height)
      // Light theme `::highlight(find-current)` in main.css: #f59e0b behind white text.
      let hits = 0
      for (let i = 0; i < data.length; i += 4) {
        const near =
          Math.abs(data[i] - 0xf5) < 24 &&
          Math.abs(data[i + 1] - 0x9e) < 24 &&
          Math.abs(data[i + 2] - 0x0b) < 40
        if (near) hits += 1
      }
      return hits / (width * height)
    },
    { png: shot, text: word }
  )
}

test('find in page paints its matches through the CSS Custom Highlight API', async ({ page }) => {
  await vaultOpen(page)
  const saved = await page.evaluate(() =>
    window.api.settings.setGeneralSettings({ theme: 'light' })
  )
  expect(saved).toMatchObject({ success: true })
  // `useThemeSync` hands the theme to next-themes, which caches it and clears the `dark` class.
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cached: window.localStorage.getItem('memry-theme'),
        dark: document.documentElement.classList.contains('dark')
      }))
    )
    .toEqual({ cached: 'light', dark: false })
  const note = await createNote(page, {
    title: `Find ${Date.now().toString(36)}`,
    content: 'Alpha needle omega',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(NOTE_EDITOR).first()
  await expect(editor).toContainText('Alpha needle omega')
  expect(await currentMatchShare(page, 'needle')).toBeLessThan(0.05)

  await editor.click()
  await page.keyboard.press('ControlOrMeta+f')
  const find = page.getByLabel('Find, replace, ask...')
  await expect(find).toBeVisible()
  await find.fill('needle')
  await expect
    .poll(() =>
      page.evaluate(() => ({
        matches: CSS.highlights.get('find-matches')?.size ?? 0,
        current: CSS.highlights.get('find-current')?.size ?? 0
      }))
    )
    .toEqual({ matches: 1, current: 1 })
  await expect.poll(() => currentMatchShare(page, 'needle')).toBeGreaterThan(0.3)
})
