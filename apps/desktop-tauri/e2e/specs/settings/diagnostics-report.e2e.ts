// The diagnostics pipeline end to end against a local HTTP stub standing in for the sync server.
//
// Path B: a warn carrying a synthetic secret goes through the renderer log pipeline into the
// redacted ring; the user previews the report, sends it, and the stub receives an incident id and
// no trace of the secret. Path B works with telemetry off.
// Path A: with telemetry disabled and the build channel `staging` (so the toggle is the only gate),
// the same warn ships nothing to /telemetry/logs, across the shutdown flush too.
import * as http from 'node:http'

import { test, expect } from '../../harness/test'
import type { Page } from '../../harness/pw-compat/page'
import { gracefulClose } from '../../harness/tauri-lifecycle'
import { waitForMainLog } from '../../harness/wait'

// Assembled at runtime: the repo secret scanner flags a full `sk-` literal even in tests. The
// value matches the API key rule of the redactor, which collapses it to `<redacted>`.
const SECRET_CORE = 'MEMRYE2ESECRETTOKEN0123456789ABCDEF'
const SECRET = `sk-${SECRET_CORE}`
const MESSAGE = 'blocked path outside allowed directories'

interface Captured {
  path: string
  body: string
}

const reports: Captured[] = []
const logs: Captured[] = []

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    // A proxied client sends the absolute form, so the path comes from a parsed URL.
    const path = new URL(request.url ?? '/', 'http://stub.invalid').pathname
    if (path === '/diagnostics/report') reports.push({ path, body })
    if (path === '/telemetry/logs') logs.push({ path, body })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0

test.use({
  syncServerUrl: `http://127.0.0.1:${port}`,
  extraEnv: { MEMRY_ENV: 'staging' }
})

const rendererReady = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => typeof window.api?.telemetry), { timeout: 30_000 })
    .toBe('object')

/** A warn with the secret in its message and in a field, through the renderer's log command. */
const logSecretWarn = (page: Page) =>
  page.evaluate(
    ([message, secret]) =>
      window.__TAURI__.core.invoke('log_write', {
        level: 'warn',
        scope: 'E2E',
        message: `${message} ${secret}`,
        fields: { filePath: secret }
      }),
    [MESSAGE, SECRET]
  )

test('Path B: a sent incident report carries the incident id and no secret', async ({
  app,
  page
}) => {
  await rendererReady(page)
  await page.evaluate(() => window.api.telemetry.setEnabled(false))
  await logSecretWarn(page)
  expect(await waitForMainLog(app, MESSAGE)).toBe(true)

  const preview = await page.evaluate(() =>
    window.api.diagnostics.previewReport({ source: 'manual' })
  )
  expect(preview.success).toBe(true)
  const previewText = JSON.stringify(preview.report)
  expect(previewText).toContain(MESSAGE)
  expect(previewText).toContain('<redacted>')
  expect(previewText).not.toContain(SECRET_CORE)

  const sent = await page.evaluate(
    (report) => window.api.diagnostics.sendReport(report),
    preview.report
  )
  expect(sent.success).toBe(true)
  expect(sent.incidentId).toMatch(/^MEMRY-[A-Z0-9]{6,12}$/)

  await expect.poll(() => reports.length, { timeout: 15_000 }).toBeGreaterThan(0)
  const body = reports[0].body
  expect(body).not.toContain(SECRET_CORE)
  const report = JSON.parse(body) as {
    incidentId: string
    lines: { message: string }[]
  }
  expect(report.incidentId).toBe(sent.incidentId)
  const line = report.lines.find((l) => l.message.includes(MESSAGE))
  // The redacted warn rides along in the report.
  expect(line).toBeTruthy()
  // `log_write` folds the fields into the message, so both secrets were scrubbed in the text.
  expect(line?.message).toContain('<redacted>')
  expect(logs).toHaveLength(0)
})

test('Path A: nothing ships to /telemetry/logs while telemetry is disabled', async ({
  app,
  page
}) => {
  await rendererReady(page)
  await page.evaluate(() => window.api.telemetry.setEnabled(false))
  expect((await page.evaluate(() => window.api.telemetry.getSettings())).enabled).toBe(false)

  await logSecretWarn(page)
  expect(await waitForMainLog(app, MESSAGE)).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  expect(logs).toHaveLength(0)

  // The shutdown flush is the last chance for a queued line to leave.
  await gracefulClose(app)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(logs).toHaveLength(0)
})
