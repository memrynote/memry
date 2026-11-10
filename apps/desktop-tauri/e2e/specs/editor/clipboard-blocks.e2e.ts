// Block menu Copy and the paste back, in each webview (#3531 14j-2a). `block-clipboard.ts` puts
// `blocknote/html`, `text/html` and `text/plain` on the copy event, and falls back to the async
// clipboard with the two standard types when no copy event fires. The OS clipboard must hold the
// note's markdown, and a paste in the app must bring the blocks back with their formatting. The
// paste runs through `e2e_webview_paste`, the webview's own paste command, because WebDriver keys
// paste nothing.
import { createNote, openFromSidebar, vaultOpen, NOTE_EDITOR } from '../../harness/notes'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

type Platform = 'darwin' | 'win32' | 'linux'

/**
 * What each webview does, observed on macOS 15 WKWebView, WebView2 131 and WebKitGTK 2.50.4 (CI)
 * and 2.52.6 (Ubuntu 24.04): the copy event fires, so all three flavours go on it, and a paste in
 * the app reads them back. WebKit keeps the custom type in its own pasteboard entry
 * (`org.webkitgtk.WebKit.custom-pasteboard-data` on Linux) and WebView2 in Chromium's web custom
 * format, so the app gets the blocks and every other app gets HTML and the markdown.
 */
const OUTCOME: Record<Platform, { copied: string[]; pasted: string[] }> = {
  darwin: {
    copied: ['blocknote/html', 'text/html', 'text/plain'],
    pasted: ['blocknote/html', 'text/html', 'text/plain']
  },
  win32: {
    copied: ['blocknote/html', 'text/html', 'text/plain'],
    pasted: ['blocknote/html', 'text/html', 'text/plain']
  },
  linux: {
    copied: ['blocknote/html', 'text/html', 'text/plain'],
    pasted: ['blocknote/html', 'text/html', 'text/plain']
  }
}

interface Recorded {
  copied: string[]
  fallback: string[] | null
  pasted: string[] | null
}

/** Records the flavours the page puts on a copy event or the async clipboard, and a paste's. */
async function recordClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: Recorded = { copied: [], fallback: null, pasted: null }
    ;(window as unknown as { __memryClipboard: Recorded }).__memryClipboard = record
    const setData = DataTransfer.prototype.setData
    DataTransfer.prototype.setData = function (this: DataTransfer, type: string, data: string) {
      record.copied.push(type)
      setData.call(this, type, data)
    }
    const write = navigator.clipboard.write.bind(navigator.clipboard)
    navigator.clipboard.write = (items) => {
      record.fallback = items.flatMap((item) => [...item.types])
      return write(items)
    }
    window.addEventListener(
      'paste',
      (event) => {
        record.pasted = [...(event.clipboardData?.types ?? [])]
      },
      true
    )
  })
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => (window as unknown as { __memryClipboard: Recorded }).__memryClipboard)

interface EditorBlock {
  content?: Array<{ text?: string; styles?: Record<string, unknown> }>
}

/** Each top-level block as its runs, a bold run wrapped in `**`. */
const blockTexts = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const editor = (window as unknown as { __memryActiveEditor: { document: EditorBlock[] } })
      .__memryActiveEditor
    return editor.document.map((block) =>
      (block.content ?? [])
        .map((run) => (run.styles?.bold ? `**${run.text ?? ''}**` : (run.text ?? '')))
        .join('')
    )
  })

test('copied blocks leave markdown on the clipboard and paste back with their formatting', async ({
  app,
  page
}) => {
  const platform = process.platform as Platform
  const webkitGtk = await invokeTest<string | null>(app, 'e2e_webkitgtk_version')
  console.log(`clipboard-blocks on ${platform}, WebKitGTK ${webkitGtk ?? '-'}`)
  if (platform === 'linux') expect(webkitGtk).toMatch(/^\d+\.\d+\.\d+$/)

  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Clipboard ${Date.now().toString(36)}`,
    content: 'First **bold** line\n\nSecond line',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  await expect(page.locator(NOTE_EDITOR).first()).toContainText('Second line')
  await recordClipboard(page)

  await page.locator('.bn-block-content').first().hover()
  await page.locator('[data-test="dragHandle"]').first().click()
  await page.getByRole('menuitem', { name: 'Copy' }).first().click()
  await expect.poll(async () => (await recorded(page)).copied).toEqual(OUTCOME[platform].copied)
  expect((await recorded(page)).fallback).toBeNull()
  // What another app pastes: the block as the note file holds it.
  await expect
    .poll(() => invokeTest<string | null>(app, 'e2e_clipboard_read'))
    .toBe('First **bold** line')

  await page.evaluate(() => {
    const editor = (
      window as unknown as {
        __memryActiveEditor: {
          document: unknown[]
          setTextCursorPosition: (block: unknown, at: 'end') => void
          focus: () => void
        }
      }
    ).__memryActiveEditor
    editor.setTextCursorPosition(editor.document.at(-1), 'end')
    editor.focus()
  })
  await invokeTest(app, 'e2e_webview_paste')
  // WebView2 lists the pasted types in another order; the set is the contract.
  await expect
    .poll(async () => (await recorded(page)).pasted?.toSorted() ?? null)
    .toEqual(OUTCOME[platform].pasted.toSorted())
  await expect
    .poll(() => blockTexts(page))
    .toEqual(['First **bold** line', 'Second line', 'First **bold** line'])
})

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
      // `::highlight(find-current)` in main.css: #f59e0b behind white text.
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
