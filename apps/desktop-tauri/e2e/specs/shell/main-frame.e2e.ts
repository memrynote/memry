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
    const page = PAGES[path]
    response
      .writeHead(page ? 200 : 204, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(page ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://${address}:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

const opens = (app: TauriApp): Promise<string[]> => invokeTest<string[]>(app, 'e2e_os_opens')

/** Marks the app's document, so a later check can tell it was never replaced or reloaded. */
async function markDocument(page: Page): Promise<string> {
  await page.evaluate(() => {
    ;(window as unknown as { __mainFrameMark?: boolean }).__mainFrameMark = true
  })
  return page.evaluate(() => location.href)
}

async function expectSameDocument(page: Page, href: string): Promise<void> {
  expect(await page.evaluate(() => location.href)).toBe(href)
  expect(
    await page.evaluate(
      () => (window as unknown as { __mainFrameMark?: boolean }).__mainFrameMark === true
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

test('a link whose click the renderer never sees opens once and leaves the app in place', async ({
  app,
  page
}) => {
  await appReady(page)
  const site = await startSite()
  try {
    const href = await markDocument(page)
    await page.evaluate((url) => {
      window.addEventListener('click', (event) => event.stopImmediatePropagation(), true)
      const link = document.createElement('a')
      link.href = url
      document.body.append(link)
      link.click()
    }, `${site.origin}/stop`)
    await expect.poll(() => opens(app), { timeout: 15_000 }).toEqual([`url ${site.origin}/stop`])
    await page.waitForTimeout(SETTLE_MS)
    expect(site.hits.filter((path) => path.startsWith('/beacon/'))).toEqual([])
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
})
