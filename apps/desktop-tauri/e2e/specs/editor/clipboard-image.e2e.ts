// The mind map's Copy as image in each webview (#3531 14j-2b). `mind-map-export.ts` writes the PNG
// through the webview's async clipboard and, when the webview refuses it, through
// `clipboard_write_image`. Either way the OS clipboard must hold the image the page drew. The
// command takes PNG bytes and nothing else, and no HTML embed in a note can reach it: on every OS
// the embed has no Tauri IPC globals (#4150), and its fetches to the command are blocked or refused.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNote, openFromSidebar, vaultOpen, NOTE_EDITOR } from '../../harness/notes'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import '../../harness/vault-commands'
import { test, expect } from '../../harness/test'

type ImagePath = 'webview' | 'app'

/**
 * Which writer puts the mind map's PNG on the clipboard, per OS, as observed in CI and locally.
 * WebKit takes the image `ClipboardItem` only while the click's gesture is live after the async
 * export: WKWebView took it on a local macOS 15 run and refused it on the slower CI `macos-arm64`
 * runner. WebKitGTK 2.50 (ubuntu-22.04) refuses it. WebView2 takes it on windows-arm64 and refuses
 * it on windows-x64 ("Document is not focused"). Each refusal goes to `clipboard_write_image`,
 * and the second test forces that path on every OS. The `['webview', 'app']` rows (darwin, win32)
 * are informational: the path is `webview` or `app` by construction, so they cannot fail. The
 * assertion there is the clipboard poll, which holds the image whichever writer put it there; only
 * the linux row (`['app']`) pins a writer.
 */
const IMAGE_PATH: Record<'darwin' | 'win32' | 'linux', ImagePath[]> = {
  darwin: ['webview', 'app'],
  win32: ['webview', 'app'],
  linux: ['app']
}

interface Recorded {
  /** The PNG's size as its IHDR declares it. */
  size: [number, number] | null
  webview: 'accepted' | 'refused' | null
  /** Why the webview refused the image. */
  error: string | null
}

/** Records the PNG the page hands the async clipboard and whether the webview took it. */
async function recordImageWrite(page: Page, refuse: boolean): Promise<void> {
  await page.evaluate((refused) => {
    const record: Recorded = { size: null, webview: null, error: null }
    ;(window as unknown as { __memryImage: Recorded }).__memryImage = record
    const write = navigator.clipboard.write.bind(navigator.clipboard)
    // The write starts before anything else is awaited: WebKit refuses it once the click's
    // gesture has expired, so a recorder that read the blob first would change the outcome.
    navigator.clipboard.write = (items) => {
      const written = (
        refused
          ? Promise.reject(new DOMException('refused by the spec', 'NotAllowedError'))
          : write(items)
      ).then(
        () => {
          record.webview = 'accepted'
          return undefined
        },
        (err: unknown) => {
          record.webview = 'refused'
          record.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
          throw err
        }
      )
      void items[0]
        .getType('image/png')
        .then((png) => png.arrayBuffer())
        .then((bytes) => {
          const header = new DataView(bytes)
          record.size = [header.getUint32(16), header.getUint32(20)]
          return undefined
        })
      return written
    }
  }, refuse)
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => (window as unknown as { __memryImage: Recorded }).__memryImage)

/**
 * The endpoints an embed can fetch to reach the command. The embed CSP (`connect-src https:`)
 * blocks the first two. `https://ipc.localhost` is Windows' IPC origin (`use_https_scheme(true)`)
 * and the CSP allows it: there Tauri refuses the raw request (no `Tauri-Invoke-Key`) with a 500,
 * and elsewhere nothing listens on it.
 */
const EMBED_IPC_URLS = [
  'ipc://localhost/clipboard_write_image',
  'http://ipc.localhost/clipboard_write_image',
  'https://ipc.localhost/clipboard_write_image'
]
const EMBED_IPC_OUTCOMES: Record<'win32' | 'other', string[]> = {
  win32: ['blocked', 'blocked', 'status 500'],
  other: ['blocked', 'blocked', 'blocked']
}

const clipboardImage = (app: Parameters<typeof invokeTest>[0]): Promise<[number, number] | null> =>
  invokeTest<[number, number] | null>(app, 'e2e_clipboard_read_image')

async function openMindMap(page: Page): Promise<void> {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Mind map ${Date.now().toString(36)}`,
    content: '# Root\n\n## Branch one\n\n## Branch two',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  await expect(page.locator(NOTE_EDITOR).first()).toContainText('Branch two')
  await page.locator('[data-testid="note-mind-map-toggle"]').click()
  await expect(page.locator('[data-testid="mind-map-toolbar-copy-image"]')).toBeEnabled()
}

for (const refuse of [false, true]) {
  test(
    refuse
      ? 'a refused image ClipboardItem still puts the mind map on the clipboard through the app'
      : 'Copy as image puts the mind map on the OS clipboard',
    async ({ app, page }) => {
      await invokeTest(app, 'e2e_clipboard_write', { text: 'before' })
      expect(await clipboardImage(app)).toBeNull()
      await openMindMap(page)
      await recordImageWrite(page, refuse)

      await page.locator('[data-testid="mind-map-toolbar-copy-image"]').click()
      await expect.poll(async () => (await recorded(page)).webview).not.toBeNull()
      await expect.poll(async () => (await recorded(page)).size).not.toBeNull()
      const { size, webview, error } = await recorded(page)
      const platform = process.platform as keyof typeof IMAGE_PATH
      console.log(
        `clipboard-image on ${platform} ${process.arch}: webview ${webview} (${error ?? '-'}), png ${String(size)}`
      )
      const path: ImagePath = webview === 'accepted' ? 'webview' : 'app'
      if (refuse) expect(path).toBe('app')
      else expect(IMAGE_PATH[platform]).toContain(path)
      expect(size?.every((side) => side > 0)).toBe(true)
      await expect.poll(() => clipboardImage(app)).toEqual(size)
    }
  )
}

test('clipboard_write_image takes PNG bytes only, and no HTML embed in a note reaches it', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  await invokeTest(app, 'e2e_clipboard_write', { text: 'before' })

  // A body that names a file is not read: the command refuses it as not a PNG.
  const refusal = await page.evaluate(
    async (path) => {
      try {
        await window.__TAURI__.core.invoke(
          'clipboard_write_image',
          new TextEncoder().encode(path),
          {
            headers: { 'x-memry-meta': '{}' }
          }
        )
        return 'written'
      } catch (err) {
        return (err as { code?: string }).code ?? String(err)
      }
    },
    join(testVaultPath, 'notes')
  )
  expect(refusal).toBe('clipboard_image_not_png')

  // The real embed of a note: the frame keeps exactly its sandbox set, and its page has neither
  // the app's IPC globals nor a way to the command's endpoint.
  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'abc123-embed.html'),
    `<!doctype html><p>embed</p><script>(async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  const out = { tauri: typeof window.__TAURI_INTERNALS__ + typeof window.__TAURI__, ipc: [] }
  for (const url of ${JSON.stringify(EMBED_IPC_URLS)}) {
    try {
      const response = await fetch(url, { method: 'POST', body: png, headers: { 'x-memry-meta': '{}' } })
      out.ipc.push('status ' + response.status)
    } catch {
      out.ipc.push('blocked')
    }
  }
  // The postMessage IPC channel of each webview, with an invoke payload for the command. The embed
  // has no Tauri window.ipc or __TAURI_INTERNALS__ on any OS (#4150). chrome.webview is WebView2's
  // own channel, not Tauri's, so only the final no-image check covers it.
  const invokeMessage = JSON.stringify({
    cmd: 'clipboard_write_image',
    callback: 1,
    error: 2,
    options: { headers: { 'x-memry-meta': '{}' } },
    payload: Array.from(png)
  })
  out.post = []
  for (const [name, channel] of [['ipc', window.ipc], ['webview2', window.chrome?.webview]]) {
    try {
      if (typeof channel?.postMessage === 'function') {
        channel.postMessage(invokeMessage)
        out.post.push(name + ' sent')
      } else {
        out.post.push(name + ' absent')
      }
    } catch (err) {
      out.post.push(name + ' threw')
    }
  }
  const internals = window.__TAURI_INTERNALS__
  out.invoke = typeof internals?.invoke !== 'function' ? 'none' : await Promise.race([
    internals.invoke('clipboard_write_image', png, { headers: { 'x-memry-meta': '{}' } }).then(
      () => 'written',
      (err) => 'refused ' + String(err?.code ?? err)
    ),
    new Promise((resolve) => setTimeout(() => resolve('no answer'), 5000))
  ])
  await new Promise((resolve) => setTimeout(resolve, 500))
  parent.postMessage(JSON.stringify(out), '*')
})()</script>`
  )
  await page.evaluate(() => {
    const state = window as unknown as { __embedReply?: string }
    window.addEventListener('message', (event) => {
      const embed = document.querySelector<HTMLIFrameElement>('[data-testid="html-embed"]')
      if (
        embed &&
        event.source === embed.contentWindow &&
        typeof event.data === 'string' &&
        event.data.includes('"ipc"')
      ) {
        state.__embedReply = event.data
      }
    })
  })
  const note = await createNote(page, {
    title: `Embed ${Date.now().toString(36)}`,
    content:
      'Above\n\n<!-- file:{"url":"../attachments/n1/abc123-embed.html","name":"embed.html","size":10,"mimeType":"text/html"} -->\n\nBelow',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const frame = page.locator('[data-testid="html-embed"]')
  await expect(frame).toHaveCount(1)
  const sandbox = await frame.getAttribute('sandbox')
  expect(sandbox?.split(' ').toSorted()).toEqual(['allow-forms', 'allow-popups', 'allow-scripts'])

  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __embedReply?: string }).__embedReply),
      { timeout: 15_000 }
    )
    .toBeTruthy()
  const reply = JSON.parse(
    await page.evaluate(() => (window as unknown as { __embedReply: string }).__embedReply)
  ) as { tauri: string; ipc: string[]; invoke: string; post: string[] }
  console.log(`clipboard-image embed on ${process.platform}: ${JSON.stringify(reply)}`)
  // No OS gives the embed Tauri's IPC globals (the patched wry keeps them out of WebView2 frames),
  // so it has no invoke to call and no window.ipc to post to.
  expect(reply.tauri).toBe('undefinedundefined')
  expect(reply.invoke).toBe('none')
  expect(reply.post[0]).toBe('ipc absent')
  expect(reply.post).toHaveLength(2)
  expect(reply.ipc).toEqual(EMBED_IPC_OUTCOMES[process.platform === 'win32' ? 'win32' : 'other'])
  // Nothing the page or the embed sent reached the clipboard.
  expect(await clipboardImage(app)).toBeNull()
  expect(await invokeTest<string | null>(app, 'e2e_clipboard_read')).toBe('before')
})
