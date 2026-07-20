/**
 * Redacted diagnostic logs E2E (deferred Task 6.1).
 *
 * Two independent guarantees of the diagnostics pipeline, end to end in a real
 * Electron process against a local HTTP stub that stands in for the sync server:
 *
 *  1. Path B (user-triggered incident report). A warn carrying a synthetic
 *     secret is logged in the main process, redacted by the log-ship transport,
 *     and ring-buffered. The user opens the consent dialog from Settings, sees a
 *     preview whose lines are redacted, and clicks Send. We assert the stub
 *     received a POST to /diagnostics/report whose body carries an incident id
 *     (MEMRY-XXXXXXXX) but NOT the raw secret, and that the same incident code is
 *     shown in the UI. Path B works regardless of the telemetry toggle.
 *
 *  2. Path A (always-on log shipping), opted out. With telemetry disabled and the
 *     build channel forced to `staging` (so the *only* thing gating shipping is
 *     the toggle, not the dev-channel block), the same secret-bearing warn must
 *     ship nothing to /telemetry/logs — verified even across the last-chance
 *     shutdown flush.
 *
 * The secret is exercised through a REAL product path — the memry-file protocol
 * handler's "blocked path outside allowed directories" warn (src/main/index.ts)
 * — so no test-only logging seam is added. The synthetic secret is an `sk-`
 * prefixed token that redact.ts collapses to `<redacted>`.
 */
import { test, expect, type Page } from '@playwright/test'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  launchElectronWithWindow,
  destroyElectronApp,
  waitForMainLog
} from './utils/electron-lifecycle'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

// Assembled from parts at runtime so the source never holds a full `sk-…` literal
// — the repo secret-scanner (scripts/check-staged-secrets.mjs) flags that shape
// even in tests. The runtime value still matches redact.ts's API_KEY rule (`sk-`
// + ≥8 chars → collapsed to <redacted>) and is exactly what must be scrubbed.
// SECRET_CORE is the distinctive body: if any partial survived redaction it would
// leak this, so we assert both are absent from what the app transmits.
const SECRET_CORE = 'MEMRYE2ESECRETTOKEN0123456789ABCDEF'
const SECRET = `sk-${SECRET_CORE}`
const BLOCKED_MSG = 'blocked path outside allowed directories'

interface CapturedRequest {
  path: string
  body: string
}

interface StubServer {
  server: http.Server
  port: number
  reportPosts: CapturedRequest[]
  logsPosts: CapturedRequest[]
  otherPosts: CapturedRequest[]
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Minimal sync-server stand-in. Records POST bodies per path and always 200s so
 * `sendIncidentReport`/log-ship see a successful ship. Bound to 127.0.0.1 to
 * avoid IPv6 localhost resolution flakiness.
 */
async function startStub(): Promise<StubServer> {
  const reportPosts: CapturedRequest[] = []
  const logsPosts: CapturedRequest[] = []
  const otherPosts: CapturedRequest[] = []

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const reqPath = (req.url ?? '').split('?')[0]
      const record: CapturedRequest = { path: reqPath, body }
      if (reqPath === '/diagnostics/report') reportPosts.push(record)
      else if (reqPath === '/telemetry/logs') logsPosts.push(record)
      else otherPosts.push(record)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) throw new Error('stub server failed to bind a port')
  return { server, port, reportPosts, logsPosts, otherPosts }
}

async function stopStub(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * Causes the main process to log a warn carrying `secret`. Fetches a memry-file
 * URL for a path well outside the vault/userData; the protocol handler responds
 * 403 and logs `memry-file: blocked path outside allowed directories` with a
 * `{ filePath }` field — which the redacting transport scrubs before the ring.
 */
async function triggerSecretWarn(page: Page, secret: string): Promise<void> {
  await page.evaluate(async (value) => {
    try {
      await fetch(`memry-file://local/memry-e2e-blocked/${value}`)
    } catch {
      // A blocked path returns 403; some engines surface that as a throw. Either
      // way the warn has already fired in the main process, which is all we need.
    }
  }, secret)
}

async function waitAppAndVault(page: Page): Promise<void> {
  await waitForAppReady(page)
  // Vault open can take tens of seconds on a cold/native-rebuilt machine.
  await waitForVaultReady(page, 90_000)
}

test('Path B: consent dialog sends a redacted incident report with the raw secret scrubbed', async () => {
  const stub = await startStub()
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-diag-b-vault-'))

  try {
    const launched = await launchElectronWithWindow({
      testVaultPath,
      extraEnv: { SYNC_SERVER_URL: `http://127.0.0.1:${stub.port}` }
    })

    try {
      const { page } = launched
      await waitAppAndVault(page)

      // Path B must work even when the user has opted out of Path A shipping.
      await page.evaluate(() => window.api.telemetry.setEnabled(false))

      // Log the secret-bearing warn, then wait until it has actually been
      // written — that guarantees the redacting transport ran and the ring holds
      // the redacted line before the dialog reads it.
      await triggerSecretWarn(page, SECRET)
      expect(await waitForMainLog(launched, BLOCKED_MSG, 20_000)).toBe(true)

      // Open the always-enabled Settings entry → shared consent dialog.
      await page.evaluate(() => window.api.quickCapture.openSettings('general'))
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('button', { name: 'Send diagnostic report' }).click()

      const consent = page.getByRole('dialog').filter({ hasText: 'Send a diagnostic report?' })
      await expect(consent).toBeVisible()

      // The preview renders the exact report Send transmits. Expand it and prove
      // the secret-bearing line is present but redacted.
      await consent
        .getByRole('button', { name: 'Preview report contents' })
        .click({ timeout: 30_000 })
      await expect(consent.getByText(new RegExp(BLOCKED_MSG))).toBeVisible({ timeout: 30_000 })
      const previewText = await consent.innerText()
      expect(previewText).toContain('<redacted>')
      expect(previewText).not.toContain(SECRET)
      expect(previewText).not.toContain(SECRET_CORE)

      await consent.getByRole('button', { name: 'Send', exact: true }).click()

      // UI confirms with the incident code.
      await expect(consent.getByText(/MEMRY-[A-Z0-9]{6,12}/)).toBeVisible({ timeout: 30_000 })

      // The server actually received the report...
      await expect.poll(() => stub.reportPosts.length, { timeout: 15_000 }).toBeGreaterThan(0)
      const post = stub.reportPosts[0]
      expect(post.path).toBe('/diagnostics/report')

      // ...carrying an incident id but NOT the raw secret, anywhere in the body.
      expect(post.body).not.toContain(SECRET)
      expect(post.body).not.toContain(SECRET_CORE)
      const report = JSON.parse(post.body) as {
        incidentId: string
        lines: Array<{ message: string; fields?: Record<string, unknown> }>
      }
      expect(report.incidentId).toMatch(/^MEMRY-[A-Z0-9]{6,12}$/)

      // The redacted secret line rode along, scrubbed.
      const blockedLine = report.lines.find((line) => line.message.includes(BLOCKED_MSG))
      expect(blockedLine, 'redacted blocked-path warn should be in the shipped report').toBeTruthy()
      expect(JSON.stringify(blockedLine)).not.toContain(SECRET)
      expect(JSON.stringify(blockedLine?.fields ?? {})).toContain('<redacted>')

      // The incident code shown in the UI matches the one transmitted.
      await expect(consent.getByText(new RegExp(report.incidentId))).toBeVisible()

      // dev-channel (no MEMRY_ENV) means Path A never ships during this test.
      expect(stub.logsPosts).toHaveLength(0)
    } finally {
      await destroyElectronApp(launched.app, [launched.userDataDir, launched.resolvedUserDataDir])
    }
  } finally {
    await stopStub(stub.server)
  }
})

test('Path A: ships nothing to /telemetry/logs while telemetry is disabled', async () => {
  const stub = await startStub()
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-diag-a-vault-'))

  try {
    // MEMRY_ENV=staging opens the build-channel gate so the telemetry toggle is
    // the ONLY thing gating log shipping — otherwise a dev build would block
    // shipping regardless and the assertion would be vacuous.
    const launched = await launchElectronWithWindow({
      testVaultPath,
      extraEnv: {
        SYNC_SERVER_URL: `http://127.0.0.1:${stub.port}`,
        MEMRY_ENV: 'staging'
      }
    })

    try {
      const { page } = launched
      await waitAppAndVault(page)

      // Opt out. Clearing the queue on disable is part of the contract we rely on.
      await page.evaluate(() => window.api.telemetry.setEnabled(false))
      const settings = await page.evaluate(() => window.api.telemetry.getSettings())
      expect(settings.enabled).toBe(false)

      // The pipeline DID see the warn (proves this isn't a no-op) — it just must
      // not ship it.
      await triggerSecretWarn(page, SECRET)
      expect(await waitForMainLog(launched, BLOCKED_MSG, 20_000)).toBe(true)

      // Give any (gated) immediate ship attempt time to reach the stub.
      await page.waitForTimeout(2_000)
      expect(stub.logsPosts).toHaveLength(0)
    } finally {
      // Teardown drives the shutdown flush (getLogShip().dispose()); a disabled
      // queue must still ship nothing even at that last chance.
      await destroyElectronApp(launched.app, [launched.userDataDir, launched.resolvedUserDataDir])
    }

    // Let any shutdown-flush POST land before the final assertion.
    await delay(1_000)
    expect(stub.logsPosts, 'no /telemetry/logs POST while telemetry disabled').toHaveLength(0)
  } finally {
    await stopStub(stub.server)
  }
})
