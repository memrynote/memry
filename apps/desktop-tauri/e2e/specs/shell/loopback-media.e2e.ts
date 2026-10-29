// The loopback media server: tokened file reads, the host and origin checks, the embed page (inv09 #50).
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
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

test('the page reads a PDF from the loopback server the way pdf.js does, whole and by range', async ({
  page,
  testVaultPath
}) => {
  await appReady(page)
  const shell = await page.evaluate(() => window.__MEMRY_SHELL__)
  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'abc123-doc.pdf')
  writeFileSync(file, `%PDF-1.4\n${'x'.repeat(4096)}\n%%EOF\n`)
  const canonical = `memry-file://local${file
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, '/$1:')
    .replace(/^\/\//, '/')}`
  const url = `${shell!.loopbackOrigin}/m/${shell!.loopbackToken}/${toBase64Url(canonical)}`

  // pdf.js reads in its worker with `fetch`, asks for the whole file first, then for ranges. The
  // page is `tauri://localhost` or `https://tauri.localhost`, so this is the mixed-content and
  // local-network check of each engine. A blob worker has the page's origin and CSP.
  const reads = await page.evaluate(
    (target) =>
      new Promise<Array<{ status: number; head: string; length: number }>>((resolve, reject) => {
        const source = `onmessage = async (event) => {
          const out = []
          for (const range of [null, 'bytes=0-1023', 'bytes=4096-']) {
            const response = await fetch(event.data, range ? { headers: { Range: range } } : {})
            const bytes = new Uint8Array(await response.arrayBuffer())
            out.push({ status: response.status, head: new TextDecoder().decode(bytes.slice(0, 5)), length: bytes.length })
          }
          postMessage(out)
        }`
        const worker = new Worker(URL.createObjectURL(new Blob([source])))
        worker.addEventListener('message', (event) => resolve(event.data))
        worker.addEventListener('error', () =>
          reject(new Error('the worker could not read the PDF'))
        )
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin
        worker.postMessage(target)
      }),
    url
  )
  expect(reads.map((r) => r.status)).toEqual([200, 206, 206])
  expect(reads[0]).toMatchObject({ head: '%PDF-' })
  expect(reads[1]).toMatchObject({ head: '%PDF-', length: 1024 })
  expect(reads[2].length).toBeGreaterThan(0)
})
