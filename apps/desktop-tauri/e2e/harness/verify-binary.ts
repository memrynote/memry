import { spawn } from 'node:child_process'

import { HarnessError } from './errors'
import { freePort } from './app-process'
import { pollUntil } from './wait'

const READY_MS = 60_000

async function w3c(port: number, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return response.json()
}

/**
 * Starts `binary` once with `MEMRY_E2E=1` and asks it for `e2e_app_info().buildKind` over the
 * embedded WebDriver. A binary built without the `e2e` feature has no driver or no command and
 * fails here with a build hint instead of timing out inside every spec.
 */
export async function verifyE2eBinary(binary: string): Promise<void> {
  const port = await freePort()
  const child = spawn(binary, [], {
    env: { ...process.env, MEMRY_E2E: '1', TAURI_WEBDRIVER_PORT: String(port) },
    stdio: 'ignore'
  })
  let sessionId: string | undefined
  try {
    const ready = await pollUntil(
      async () => {
        try {
          return (await w3c(port, 'GET', '/status')).value?.ready === true
        } catch {
          return false
        }
      },
      { timeoutMs: READY_MS, intervalMs: 250 }
    )
    if (!ready) {
      throw new HarnessError(
        `${binary} exposes no WebDriver on port ${port}; build it with pnpm build:e2e (feature e2e)`
      )
    }
    const created = await w3c(port, 'POST', '/session', { capabilities: { alwaysMatch: {} } })
    sessionId = created.value?.sessionId
    if (!sessionId) throw new HarnessError(`no WebDriver session: ${JSON.stringify(created)}`)
    const info = await pollUntil(
      async () => {
        const result = await w3c(port, 'POST', `/session/${sessionId}/execute/async`, {
          script: `const done = arguments[arguments.length - 1];
            if (!window.__TAURI__) return done(null);
            window.__TAURI__.core.invoke('e2e_app_info').then(done, () => done(null));`,
          args: []
        })
        return result.value ?? undefined
      },
      { timeoutMs: READY_MS, intervalMs: 500 }
    )
    if (info?.buildKind !== 'e2e') {
      throw new HarnessError(
        `${binary} did not answer e2e_app_info; it was not built with the e2e feature (pnpm build:e2e)`
      )
    }
  } finally {
    if (sessionId) await w3c(port, 'DELETE', `/session/${sessionId}`).catch(() => undefined)
    child.kill('SIGKILL')
  }
}
