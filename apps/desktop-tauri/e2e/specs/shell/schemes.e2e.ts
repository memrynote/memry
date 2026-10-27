// The memry-file scheme, the loopback media server and the CSP (inv09 #44 #45 #47 #49 #50).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appReady } from '../../harness/app-ready'
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
  expect(await read(file, 'bytes=-3')).toEqual({ status: 206, text: '789' })
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
