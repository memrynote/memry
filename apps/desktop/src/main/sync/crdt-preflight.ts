import path from 'path'
import { utilityProcess } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtPreflight')

const PREFLIGHT_TIMEOUT_MS = 10_000

export interface CrdtPreflightResult {
  ok: boolean
  reason?: string
}

/**
 * Verify the classic-level native binding survives real use — in a disposable
 * utilityProcess, before the main process ever loads it. The child probes the
 * REAL store directory, so both a binding that hard-aborts (no JS error, no
 * uncaughtException) and a store whose on-disk state aborts the binding (torn
 * LDB/MANIFEST from a past crash) kill the child, not the app.
 *
 * No verdict cache: the provider latches init (persistenceReady) so a verdict
 * is only ever requested again after it quarantined the store — and that retry
 * must genuinely re-probe. See crdt-preflight-child.ts and crdt-provider.ts.
 */
export function runCrdtPreflight(storeDir: string): Promise<CrdtPreflightResult> {
  return execPreflight(storeDir).catch((err) => {
    log.error('CRDT preflight failed to run', { error: err })
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  })
}

async function execPreflight(storeDir: string): Promise<CrdtPreflightResult> {
  const childPath = path.join(__dirname, 'crdt-preflight-child.js')
  const startedAt = Date.now()

  return await new Promise<CrdtPreflightResult>((resolve) => {
    let settled = false
    let stderr = ''

    const settle = (result: CrdtPreflightResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result.ok) {
        log.debug('CRDT preflight passed', { storeDir, elapsedMs: Date.now() - startedAt })
      } else {
        log.error('CRDT store failed preflight — CRDT layer will run in-memory', {
          storeDir,
          reason: result.reason,
          stderr: stderr.slice(0, 2000),
          elapsedMs: Date.now() - startedAt
        })
      }
      resolve(result)
    }

    const child = utilityProcess.fork(childPath, [storeDir], {
      // Label the fork so a native abort here surfaces as 'CrdtPreflight' in
      // `ps` and child-process-gone telemetry instead of an anonymous
      // 'Node Utility Process' (the long-lived workers already set this).
      serviceName: 'CrdtPreflight',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env }
    })

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      settle({ ok: false, reason: `timed out after ${PREFLIGHT_TIMEOUT_MS}ms` })
    }, PREFLIGHT_TIMEOUT_MS)

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.once('exit', (code: number) => {
      settle(code === 0 ? { ok: true } : { ok: false, reason: `child exited with code ${code}` })
    })
  })
}
