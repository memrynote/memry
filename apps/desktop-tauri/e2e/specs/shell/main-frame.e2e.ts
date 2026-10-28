// The main frame never shows, or runs script from, a page outside the app (inv09 #48): the shell
// decides every main-frame navigation before it commits (`shell::navigation_guard`). A page that
// committed could cancel the way back with `window.stop()`, chain hops to the OS browser, or open
// windows; each fixture below would, if it ever ran.
import { mkdirSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import type { TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import type { Page } from '../../harness/pw-compat/page'

/** A synchronous request, so the beacon reaches the site before `window.stop()` can cancel it. */
const beacon = (name: string): string =>
  `var x = new XMLHttpRequest(); x.open('GET', '/beacon/${name}', false); x.send();`

const PAGES: Record<string, string> = {
  '/stop': `<!doctype html><head><script>${beacon('stop')} window.stop()</script></head><body>stop</body>`,
  '/chain': `<!doctype html><script>${beacon('chain')} location.replace('/chain-2')</script>`,
  '/chain-2': `<!doctype html><script>${beacon('chain-2')} location.replace('/chain-3')</script>`,
  '/chain-3': `<!doctype html><script>${beacon('chain-3')}</script>`,
  '/popup': `<!doctype html><script>${beacon('popup')} window.open('/opened'); window.open('/opened-2')</script>`,
  '/landing': `<!doctype html><script>${beacon('landing')}</script>`
}

interface Site {
  origin: string
  /** The same site at a loopback address, which the app's CSP lets its page fetch. */
  loopback: string
  /** Every path the site was asked for, beacons included. */
  hits: string[]
  close(): Promise<void>
}

/**
 * A web site on this machine that the app treats as the web: the guard never hands a loopback URL
 * to the OS, so the site listens on every interface and is addressed by the machine's LAN address.
 */
async function startSite(): Promise<Site> {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
  if (!address) throw new Error('no non-loopback IPv4 address to serve the fixture site from')
  const hits: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/'
    hits.push(path)
    if (path === '/redirect') {
      response.writeHead(302, { Location: '/landing' }).end()
      return
    }
    if (path === '/slow') {
      // A request of the app's page that is still in flight when a navigation is refused.
      setTimeout(() => {
        response.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('slow')
      }, 2500)
      return
    }
    const page = PAGES[path]
    response
      .writeHead(page ? 200 : 204, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(page ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://${address}:${port}`,
    loopback: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

const opens = (app: TauriApp): Promise<string[]> => invokeTest<string[]>(app, 'e2e_os_opens')

/** Marks the app's document, so a later check can tell it was never replaced or reloaded. */
async function markDocument(page: Page): Promise<string> {
  await page.evaluate(() => {
    const state = window as unknown as { __mainFrameMark?: number }
    state.__mainFrameMark = history.length
  })
  return page.evaluate(() => location.href)
}

/** The same app document, with no history entry added by a refused navigation. */
async function expectSameDocument(page: Page, href: string): Promise<void> {
  expect(await page.evaluate(() => location.href)).toBe(href)
  expect(
    await page.evaluate(
      () => (window as unknown as { __mainFrameMark?: number }).__mainFrameMark === history.length
    )
  ).toBe(true)
  expect(await page.evaluate(() => typeof window.__MEMRY_SHELL__)).toBe('object')
}

/** Long enough for a committed page to beacon, hop or open a window. */
const SETTLE_MS = 2500

test('a page that would stop, chain, redirect or open windows never runs, and opens once', async ({
  app,
  page
}) => {
  await appReady(page)
  const site = await startSite()
  try {
    const href = await markDocument(page)
    const expected: string[] = []
    for (const path of ['/stop', '/chain', '/redirect', '/popup']) {
      // A script that assigns `location`: the renderer's click listener never sees it.
      await page.evaluate((url) => location.assign(url), `${site.origin}${path}`)
      // WebKitGTK hands the main frame's URL over only once the load ended, after the redirect.
      const opened = path === '/redirect' && process.platform === 'linux' ? '/landing' : path
      expected.push(`url ${site.origin}${opened}`)
      await expect.poll(() => opens(app), { timeout: 15_000 }).toEqual(expected)
    }
    await page.waitForTimeout(SETTLE_MS)

    // Each navigation reached the OS once, no page ran a line of script, and the app document
    // stayed where it was.
    expect(await opens(app)).toEqual(expected)
    expect(site.hits.filter((path) => path.startsWith('/beacon/'))).toEqual([])
    expect(
      site.hits.filter((path) => path.startsWith('/chain-') || path.startsWith('/opened'))
    ).toEqual([])
    await expectSameDocument(page, href)
  } finally {
    await site.close()
  }
})

test('a link whose click an app handler stops still opens once, with no unload', async ({
  app,
  page
}) => {
  await appReady(page)
  const site = await startSite()
  try {
    const href = await markDocument(page)
    // App handlers that stop the click at every level after the guard's own window listener.
    await page.evaluate((url) => {
      const state = window as unknown as { __unloaded?: boolean }
      window.addEventListener('beforeunload', () => {
        state.__unloaded = true
      })
      window.addEventListener('click', (event) => event.stopImmediatePropagation(), true)
      document.addEventListener('click', (event) => event.stopPropagation(), true)
      const link = document.createElement('a')
      link.href = url
      link.addEventListener('click', (event) => event.stopPropagation())
      document.body.append(link)
      link.click()
    }, `${site.origin}/stop`)
    await expect.poll(() => opens(app), { timeout: 15_000 }).toEqual([`url ${site.origin}/stop`])
    await page.waitForTimeout(SETTLE_MS)
    expect(site.hits).toEqual([])
    expect(
      await page.evaluate(() => (window as unknown as { __unloaded?: boolean }).__unloaded === true)
    ).toBe(false)
    await expectSameDocument(page, href)
  } finally {
    await site.close()
  }
})

/** The URL a webview loads for a vault file: the scheme's own, or WebView2's `https` host. */
function webviewUrl(scheme: 'memry-file' | 'memry-html', file: string): string {
  const encoded = file
    .replaceAll('\\', '/')
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'))
    .join('/')
  const rooted = encoded.startsWith('/') ? encoded : `/${encoded}`
  return process.platform === 'win32'
    ? `https://${scheme}.localhost/local${rooted}`
    : `${scheme}://local${rooted}`
}

test('an embed never replaces the app, and a vault file in the main frame goes to the OS', async ({
  app,
  page,
  testVaultPath
}) => {
  await appReady(page)
  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  const embed = join(folder, 'abc123-main.html')
  writeFileSync(embed, '<!doctype html><title>embed</title><p>embed</p>')
  const pdf = join(folder, 'abc123-doc.pdf')
  writeFileSync(pdf, '%PDF-1.4\n')
  const href = await markDocument(page)

  // Tauri counts a registered scheme's page as local, so an embed in the main frame could call
  // the app's commands: it is refused before it loads.
  await page.evaluate((url) => location.assign(url), webviewUrl('memry-html', embed))
  await page.waitForTimeout(SETTLE_MS)
  await expectSameDocument(page, href)
  expect(await opens(app)).toEqual([])

  await page.evaluate((url) => location.assign(url), webviewUrl('memry-file', pdf))
  await expect.poll(() => opens(app), { timeout: 15_000 }).toHaveLength(1)
  expect((await opens(app))[0]).toMatch(/^path .*abc123-doc\.pdf$/)
  await page.waitForTimeout(SETTLE_MS)
  expect(await opens(app)).toHaveLength(1)
  await expectSameDocument(page, href)

  // A file block's Download: the engines ignore `download` on another origin and would navigate.
  // The renderer takes the click, and the file opens in its app, as in Electron.
  const zip = join(folder, 'abc123-archive.zip')
  writeFileSync(zip, 'PK')
  const site = await startSite()
  await page.evaluate((url) => {
    const state = window as unknown as { __unloaded?: boolean; __slow?: Promise<string> }
    window.addEventListener('beforeunload', () => {
      state.__unloaded = true
    })
    state.__slow = fetch(url).then(
      (response) => response.text(),
      (error: unknown) => `failed ${String(error)}`
    )
  }, `${site.loopback}/slow`)
  await page.evaluate(
    (url) => {
      const link = document.createElement('a')
      link.href = url
      link.download = 'archive.zip'
      link.textContent = 'Download'
      document.body.append(link)
      link.click()
    },
    webviewUrl('memry-file', zip)
  )
  await expect.poll(() => opens(app), { timeout: 15_000 }).toHaveLength(2)
  expect((await opens(app))[1]).toMatch(/^path .*abc123-archive\.zip$/)
  await page.waitForTimeout(SETTLE_MS)
  expect(await opens(app)).toHaveLength(2)
  // WebKitGTK refuses a started navigation only after beforeunload ran and the requests stopped.
  const slow = await page.evaluate(() => (window as unknown as { __slow: Promise<string> }).__slow)
  expect(slow).toBe('slow')
  const unloaded = await page.evaluate(
    () => (window as unknown as { __unloaded?: boolean }).__unloaded === true
  )
  expect(unloaded).toBe(false)
  await site.close()
  await expectSameDocument(page, href)
})

test('a vault file opens in its app only when it is a type the app opens (#3704)', async ({
  app,
  page,
  testVaultPath
}) => {
  await appReady(page)
  const folder = join(testVaultPath, 'attachments', 'n2')
  mkdirSync(folder, { recursive: true })
  const svg = join(folder, 'abc123-image.svg')
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const py = join(folder, 'abc123-tool.py')
  writeFileSync(py, 'print(1)\n')
  // On macOS `open` runs a file with an exec bit in Terminal, whatever its name says.
  const unix = process.platform !== 'win32'
  const bare = join(folder, 'abc123-tool')
  const pdf = join(folder, 'abc123-tool.pdf')
  if (unix) {
    writeFileSync(bare, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(pdf, '#!/bin/sh\n', { mode: 0o755 })
  }
  const href = await markDocument(page)
  const click = (path: string): Promise<void> =>
    page.evaluate(
      (url) => {
        const link = document.createElement('a')
        link.href = url
        document.body.append(link)
        link.click()
        link.remove()
      },
      webviewUrl('memry-file', path)
    )

  // A browser would run an SVG's script, Python runs a .py, and an executable runs whatever it
  // is named: each is shown in the file manager instead of opened.
  const shown = unix ? [svg, py, bare, pdf] : [svg, py]
  for (const [index, path] of shown.entries()) {
    await click(path)
    await expect.poll(() => opens(app), { timeout: 15_000 }).toHaveLength(index + 1)
  }
  await page.waitForTimeout(SETTLE_MS)
  const recorded = await opens(app)
  expect(recorded).toHaveLength(shown.length)
  for (const [index, path] of shown.entries()) {
    const name = path.slice(folder.length + 1).replaceAll('.', '\\.')
    expect(recorded[index]).toMatch(new RegExp(`^reveal .*${name}$`))
  }
  await expectSameDocument(page, href)
})

test('about:blank, data: and blob: never replace the app', async ({ app, page }) => {
  await appReady(page)
  const href = await markDocument(page)
  const blob = await page.evaluate(() =>
    URL.createObjectURL(new Blob(['<p>blob</p>'], { type: 'text/html' }))
  )
  for (const url of ['about:blank', 'data:text/html,<p>data</p>', blob]) {
    await page.evaluate((target) => location.assign(target), url)
    await page.waitForTimeout(SETTLE_MS)
    await expectSameDocument(page, href)
  }
  expect(await opens(app)).toEqual([])
})

// `window.open` goes to the engine, whose popup blocker decides whether a new window is asked for
// at all. WebDriver clicks are untrusted, so WKWebView and WebKitGTK refuse the call before the
// shell sees anything; on macOS a trusted click does not reach the shell either (#3675), so app
// code calls `openLink` instead (the next test). What reaches the shell opens once in the OS. A
// target=_blank link is the renderer's: one open.
test('window.open and a target=_blank link never load in the window and open at most once', async ({
  app,
  page
}) => {
  await appReady(page)
  const site = await startSite()
  try {
    const href = await markDocument(page)
    await page.evaluate((url) => {
      window.open(url)
    }, `${site.origin}/landing`)
    await page.evaluate((url) => {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.addEventListener('click', (event) => event.stopPropagation())
      document.body.append(link)
      link.click()
    }, `${site.origin}/stop`)
    await page.waitForTimeout(SETTLE_MS)
    const opened = await opens(app)
    expect(opened.filter((entry) => entry === `url ${site.origin}/stop`)).toHaveLength(1)
    expect(
      opened.filter((entry) => entry !== `url ${site.origin}/stop`).length
    ).toBeLessThanOrEqual(1)
    for (const entry of opened) {
      expect([`url ${site.origin}/landing`, `url ${site.origin}/stop`]).toContain(entry)
    }
    expect(site.hits.filter((path) => path.startsWith('/beacon/'))).toEqual([])
    await expectSameDocument(page, href)
  } finally {
    await site.close()
  }
})

// An "open in browser" action of the app: `openLink` hands the URL to the shell, so it opens on
// every engine, macOS included, where `window.open` opened nothing (#3675).
test('the sidebar help menu opens its link in the OS browser', async ({ app, page }) => {
  await appReady(page)
  const href = await markDocument(page)
  await page.locator('[data-tour="feedback"]').click()
  await page.getByRole('menuitem', { name: 'Report a bug' }).click()
  await expect
    .poll(() => opens(app), { timeout: 15_000 })
    .toEqual(['url https://github.com/memrynote/memry/issues/new?template=bug.yml'])
  await page.waitForTimeout(SETTLE_MS)
  expect(await opens(app)).toHaveLength(1)
  await expectSameDocument(page, href)
})

// The gestures dispatch the events a real one fires; a real mouse and a real drag from another app
// were checked on the Ubuntu VM (see the PR).
test('no link gesture or drop unloads the app, cancels its requests or loads in the window', async ({
  app,
  page
}) => {
  await appReady(page)
  const site = await startSite()
  try {
    const href = await markDocument(page)
    // An in-flight request of the app and its beforeunload: a navigation that started, even one
    // refused later, runs the one and cancels the other (WebKitGTK), and Tauri would resend an
    // aborted command.
    await page.evaluate((url) => {
      const state = window as unknown as { __unloaded?: boolean; __slow?: Promise<string> }
      window.addEventListener('beforeunload', () => {
        state.__unloaded = true
      })
      state.__slow = fetch(url).then(
        (response) => response.text(),
        (error: unknown) => `failed ${String(error)}`
      )
    }, `${site.loopback}/slow`)

    const result = await page.evaluate((origin) => {
      // Outside the sidebar's file-drop zone, and the zone itself.
      const outside = document.querySelector('[data-sidebar="footer"]')
      const zone = document.querySelector('[data-tour="sidebar-collections"]')
      if (!outside || !zone || zone.contains(outside))
        return { missing: true, fileTypes: [] as string[], claims: [] as string[] }
      // Who claims a drop after the guard: the sidebar's file-drop zone must keep its files.
      const claims: string[] = []
      for (const type of ['dragover', 'drop']) {
        window.addEventListener(
          type,
          (event) => {
            const claim = event.preventDefault.bind(event)
            Object.defineProperty(event, 'preventDefault', {
              configurable: true,
              value: () => {
                claims.push(`${type} ${zone.contains(event.target as Node) ? 'zone' : 'other'}`)
                claim()
              }
            })
          },
          true
        )
      }
      const link = (path: string): HTMLAnchorElement => {
        const anchor = document.createElement('a')
        anchor.href = origin + path
        anchor.textContent = path
        outside.append(anchor)
        return anchor
      }
      const mouse = (target: Element, type: string, init: MouseEventInit): void => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
      }
      mouse(link('/left'), 'click', { button: 0 })
      mouse(link('/middle'), 'auxclick', { button: 1 })
      mouse(link('/ctrl'), 'click', { button: 0, ctrlKey: true })
      // Enter on a focused link fires this same click.
      link('/enter').click()
      const fileTypes: string[] = []
      const dragAll = (target: Element, fill: (data: DataTransfer) => void): void => {
        const data = new DataTransfer()
        fill(data)
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })
          )
        }
      }
      const addFile = (data: DataTransfer): void => {
        data.items.add(new File(['# x'], 'dropped.md', { type: 'text/markdown' }))
        fileTypes.push(...data.types)
      }
      dragAll(outside, (data) => data.setData('text/uri-list', `${origin}/dragged`))
      dragAll(outside, addFile)
      dragAll(zone, addFile)
      return { missing: false, fileTypes, claims }
    }, site.origin)

    expect(result.missing).toBe(false)
    expect(result.fileTypes).toContain('Files')
    expect(result.claims).toEqual(['dragover zone', 'drop zone'])
    await expect
      .poll(() => opens(app), { timeout: 15_000 })
      .toEqual(
        ['/left', '/middle', '/ctrl', '/enter', '/dragged'].map((p) => `url ${site.origin}${p}`)
      )
    const slow = await page.evaluate(
      () => (window as unknown as { __slow: Promise<string> }).__slow
    )
    expect(slow).toBe('slow')
    expect(
      await page.evaluate(() => (window as unknown as { __unloaded?: boolean }).__unloaded === true)
    ).toBe(false)
    expect(site.hits.filter((path) => path !== '/slow')).toEqual([])
    await expectSameDocument(page, href)
  } finally {
    await site.close()
  }
})

test('back, forward and reload keep the app', async ({ app, page }) => {
  await appReady(page)
  const site = await startSite()
  try {
    await markDocument(page)
    await page.evaluate((url) => location.assign(url), `${site.origin}/stop`)
    await expect.poll(() => opens(app), { timeout: 15_000 }).toHaveLength(1)
    // Back and forward over a hash route stay in the same document.
    const base = await page.evaluate(() => location.href)
    const origin = await page.evaluate(() => location.origin)
    await page.evaluate(() => {
      location.hash = '#main-frame-check'
    })
    await page.evaluate(() => history.back())
    await expect.poll(() => page.evaluate(() => location.href)).toBe(base)
    await page.evaluate(() => history.forward())
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#main-frame-check')
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { __mainFrameMark?: number }).__mainFrameMark
      )
    ).toBe('number')
    // A reload loads the app again.
    await page.evaluate(() => location.reload())
    await appReady(page)
    expect(await page.evaluate(() => location.origin)).toBe(origin)
    expect(await page.evaluate(() => typeof window.__MEMRY_SHELL__)).toBe('object')
    expect(await opens(app)).toHaveLength(1)
    expect(site.hits.filter((path) => path.startsWith('/beacon/'))).toEqual([])
  } finally {
    await site.close()
  }
})
