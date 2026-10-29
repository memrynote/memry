// The memry-file scheme, the loopback media server and the CSP (inv09 #44 #45 #47 #49 #50).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const TAURI_CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src-tauri/tauri.conf.json'
)

/** A policy as directive name to sources. Tauri rebuilds the header from a map, so order differs. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name !== '')
      .map(([name, ...sources]) => [name, sources])
  )
}

/** What `served` lacks of `configured`, and what it adds beyond Tauri's own nonces and hashes. */
function policyDrift(served: string, configured: string): string[] {
  const want = directives(configured)
  const got = directives(served)
  const drift: string[] = []
  for (const name of new Set([...want.keys(), ...got.keys()])) {
    const wanted = want.get(name) ?? []
    const sources = got.get(name) ?? []
    for (const source of wanted)
      if (!sources.includes(source)) drift.push(`${name} lacks ${source}`)
    for (const source of sources) {
      // Tauri adds a nonce or a hash to script-src and style-src for each inline script or style.
      const tauriOwn =
        (name === 'script-src' || name === 'style-src') &&
        /^'(nonce|sha256|sha384|sha512)-/.test(source)
      if (!wanted.includes(source) && !tauriOwn) drift.push(`${name} adds ${source}`)
    }
  }
  return drift
}

test('the CSP blocks an injected inline script, and is the configured policy', async ({ page }) => {
  await appReady(page)
  const result = await page.evaluate(async () => {
    const violated: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => {
      violated.push(event.originalPolicy)
    })
    const script = document.createElement('script')
    script.textContent = 'window.__injected = true'
    document.body.append(script)
    for (let tries = 0; violated.length === 0 && tries < 40; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const appPage = await fetch(`${location.protocol}//${location.host}/`)
    return {
      ran: (window as unknown as { __injected?: boolean }).__injected === true,
      enforced: violated[0] ?? null,
      header: appPage.headers.get('content-security-policy')
    }
  })
  expect(result.ran).toBe(false)
  const configured = (
    JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { app: { security: { csp: string } } }
  ).app.security.csp
  // The policy the page enforces, as the engine reports it, and the header the app page is
  // served with.
  expect(policyDrift(result.enforced ?? '', configured)).toEqual([])
  expect(policyDrift(result.header ?? '', configured)).toEqual([])
})

// The webview has no certificate pin: every memry-host request goes through the Rust transport,
// and `connect-src` names no memrynote.com host, so a request from the renderer is refused
// (`scripts/check-renderer-no-sync-host.mjs` is the source-level backstop).
test('the CSP refuses a webview request to a memry host', async ({ page }) => {
  await appReady(page)
  // The violation report is the evidence: a refused fetch alone proves nothing, since CORS refuses
  // this one whatever the CSP says.
  const violations = await page.evaluate(async () => {
    const blocked: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => {
      blocked.push(`${event.effectiveDirective} ${event.blockedURI}`)
    })
    await fetch('https://sync.memrynote.com/health').catch(() => undefined)
    try {
      new WebSocket('wss://sync.memrynote.com/sync').close()
    } catch {
      // An engine may throw for a blocked socket rather than fail it later; the report is the same.
    }
    for (let tries = 0; blocked.length < 2 && tries < 40; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return blocked
  })
  const reports = violations.join('\n')
  expect(reports).toMatch(/^connect-src https:\/\/sync\.memrynote\.com/m)
  expect(reports).toMatch(/^connect-src wss:\/\/sync\.memrynote\.com/m)
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
