// The memry-file and memry-html schemes and the frame guard (inv09 #45 #46 #47).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import { test, expect } from '../../harness/test'

test('memry-file serves a vault file, ranges, and refuses a path outside the roots', async ({
  page,
  testVaultPath
}) => {
  await appReady(page)
  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'abc123-clip.txt')
  writeFileSync(file, '0123456789')
  const outsideDir = mkdtempSync(join(tmpdir(), 'memry-e2e-outside-'))
  const outside = join(outsideDir, 'secret.txt')
  writeFileSync(outside, 'secret')

  const read = (path: string, range?: string) =>
    page.evaluate(
      async ({ target, byteRange }) => {
        const platform = document.documentElement.getAttribute('data-platform')
        const encoded = target
          .replaceAll('\\', '/')
          .split('/')
          .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'))
          .join('/')
        const rooted = encoded.startsWith('/') ? encoded : `/${encoded}`
        // On Windows the app's own page proves itself with the launch token in the URL.
        const url =
          platform === 'win32'
            ? `https://memry-file.localhost/local${rooted}?t=${window.__MEMRY_SHELL__?.loopbackToken}`
            : `memry-file://local${rooted}`
        const response = await fetch(url, byteRange ? { headers: { Range: byteRange } } : {})
        return { status: response.status, text: await response.text() }
      },
      { target: path, byteRange: range }
    )

  expect(await read(file)).toEqual({ status: 200, text: '0123456789' })
  expect(await read(file, 'bytes=2-4')).toEqual({ status: 206, text: '234' })
  // A suffix range (`bytes=-3`) is not CORS-safelisted, so a cross-origin fetch would preflight; the
  // unit tests cover it.
  expect(await read(file, 'bytes=7-')).toEqual({ status: 206, text: '789' })
  expect((await read(file, 'bytes=50-')).status).toBe(416)
  expect((await read(outside)).status).toBe(403)
})

/** The URL a webview loads for a vault file: the scheme's own, or WebView2's `https` host. */
function webviewUrl(scheme: 'memry-file' | 'memry-html', file: string): string {
  const slashed = file.replaceAll('\\', '/')
  const encoded = slashed
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'))
    .join('/')
  const rooted = encoded.startsWith('/') ? encoded : `/${encoded}`
  return process.platform === 'win32'
    ? `https://${scheme}.localhost/local${rooted}`
    : `${scheme}://local${rooted}`
}

test('a memry-html embed loads in the app, runs, and can read neither the vault nor the token', async ({
  app,
  page,
  testVaultPath
}) => {
  await appReady(page)
  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  const secret = join(folder, 'abc123-secret.txt')
  writeFileSync(secret, 'vault-secret')
  // A vault script an embed points at must not run: its globals would be the embed's.
  const script = join(folder, 'abc123-leak.js')
  writeFileSync(script, 'var leaked = 1')
  const embed = join(folder, 'abc123-embed.html')
  writeFileSync(
    embed,
    `<!doctype html><script src=${JSON.stringify(webviewUrl('memry-file', script))}></script><script>(async () => {
  const out = { shell: typeof window.__MEMRY_SHELL__, leaked: typeof leaked, fetched: 'blocked' }
  try {
    const response = await fetch(${JSON.stringify(webviewUrl('memry-file', secret))})
    out.fetched = response.ok ? await response.text() : 'status ' + response.status
  } catch {}
  parent.postMessage(JSON.stringify(out), '*')
})()</script>`
  )
  const before = await page.evaluate(() => location.href)

  const reply = await page.evaluate(
    (src) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 15000)
        window.addEventListener(
          'message',
          (event) => {
            clearTimeout(timer)
            resolve(String(event.data))
          },
          { once: true }
        )
        const frame = document.createElement('iframe')
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
        frame.src = src
        document.body.append(frame)
      }),
    webviewUrl('memry-html', embed)
  )

  // The embed ran (so the guard let its frame load), saw no shell globals, and read no vault bytes.
  expect(reply).not.toBe('timeout')
  const seen = JSON.parse(reply) as { shell: string; leaked: string; fetched: string }
  expect(seen.shell).toBe('undefined')
  expect(seen.leaked).toBe('undefined')
  expect(seen.fetched).not.toContain('vault-secret')
  // The app stayed on its own page and nothing left for the OS.
  expect(await page.evaluate(() => location.href)).toBe(before)
  expect(await invokeTest<string[]>(app, 'e2e_os_opens')).toEqual([])
})

test('a web page nested in an embed, or a meta refresh, never opens the OS browser', async ({
  app,
  page,
  testVaultPath
}) => {
  await appReady(page)
  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  const nested = join(folder, 'abc123-nested.html')
  writeFileSync(nested, '<!doctype html><iframe src="https://example.com/nested"></iframe>')
  const refreshed = join(folder, 'abc123-refresh.html')
  writeFileSync(
    refreshed,
    '<!doctype html><meta http-equiv="refresh" content="0;url=https://example.com/refreshed">'
  )

  // The embed page nests a web page, so a loaded one has one subframe (readable across origins).
  const nestedFrames = await page.evaluate(
    (src) =>
      new Promise<number>((resolve) => {
        const frame = document.createElement('iframe')
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
        frame.src = src
        document.body.append(frame)
        const started = Date.now()
        const poll = setInterval(() => {
          const count = frame.contentWindow?.length ?? 0
          if (count > 0 || Date.now() - started > 15000) {
            clearInterval(poll)
            resolve(count)
          }
        }, 100)
      }),
    webviewUrl('memry-html', nested)
  )
  expect(nestedFrames).toBe(1)

  await page.evaluate(
    (src) => {
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
      frame.src = src
      document.body.append(frame)
    },
    webviewUrl('memry-html', refreshed)
  )
  await page.waitForTimeout(2000)

  // Neither a frame's own load nor its refresh is a link the user clicked.
  expect(await invokeTest<string[]>(app, 'e2e_os_opens')).toEqual([])
})
