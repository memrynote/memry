// The memry-file scheme, the loopback media server and the CSP (inv09 #44 #45 #47 #49 #50).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import { test, expect } from '../../harness/test'

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** A GET with a chosen Host header, which `fetch` forbids. */
function get(origin: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const toBase64Url = (text: string): string => Buffer.from(text).toString('base64url')

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
        const url =
          platform === 'win32'
            ? `https://memry-file.localhost/local${rooted}`
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

test('the loopback server streams with a token, refuses a foreign host, and frames only YouTube', async ({
  page,
  testVaultPath
}) => {
  await appReady(page)
  const shell = await page.evaluate(() => window.__MEMRY_SHELL__)
  expect(shell?.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const origin = shell!.loopbackOrigin
  const token = shell!.loopbackToken
  const host = new URL(origin).host

  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'abc123-clip.mp4'), '0123456789')
  const canonical = `memry-file://local${join(folder, 'abc123-clip.mp4')
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, '/$1:')
    .replace(/^\/\//, '/')}`
  const media = `/m/${token}/${toBase64Url(canonical)}`

  const ok = await get(origin, media, { Range: 'bytes=1-3' })
  expect(ok.status).toBe(206)
  expect(ok.body).toBe('123')

  expect((await get(origin, media, { Host: 'evil.example.com' })).status).toBe(403)
  // A sandboxed embed reads with `Origin: null`; only the app's own origin may read a file.
  expect((await get(origin, media, { Origin: 'null' })).status).toBe(403)
  const app = await get(origin, media, {
    Origin: process.platform === 'win32' ? 'https://tauri.localhost' : 'tauri://localhost'
  })
  expect(app.status).toBe(200)
  expect(app.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
  expect((await get(origin, media.replace(token, '0'.repeat(64)))).status).toBe(404)

  const embed = await get(origin, `/e/${token}/youtube/dQw4w9WgXcQ`, { Host: host })
  expect(embed.status).toBe(200)
  expect(embed.headers['content-security-policy']).toBe(
    "default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'"
  )
  expect(embed.body).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
})

test('the CSP blocks an injected inline script', async ({ page }) => {
  await appReady(page)
  const ran = await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__injected = true'
    document.body.append(script)
    return (window as unknown as { __injected?: boolean }).__injected === true
  })
  expect(ran).toBe(false)
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
  const embed = join(folder, 'abc123-embed.html')
  writeFileSync(
    embed,
    `<!doctype html><script>(async () => {
  const out = { shell: typeof window.__MEMRY_SHELL__, fetched: 'blocked' }
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
  const seen = JSON.parse(reply) as { shell: string; fetched: string }
  expect(seen.shell).toBe('undefined')
  expect(seen.fetched).not.toContain('vault-secret')
  // The app stayed on its own page and nothing left for the OS.
  expect(await page.evaluate(() => location.href)).toBe(before)
  expect(await invokeTest<string[]>(app, 'e2e_os_opens')).toEqual([])
})

test('the YouTube embed page loads in the app and its player is not sent to the browser', async ({
  app,
  page
}) => {
  await appReady(page)
  const shell = await page.evaluate(() => window.__MEMRY_SHELL__)
  const src = `${shell!.loopbackOrigin}/e/${shell!.loopbackToken}/youtube/dQw4w9WgXcQ`
  // The page nests the player, so a loaded page has one subframe; the count is readable across
  // origins.
  const frames = await page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const frame = document.createElement('iframe')
        frame.src = url
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
    src
  )
  expect(frames).toBe(1)
  expect(await invokeTest<string[]>(app, 'e2e_os_opens')).toEqual([])
})
