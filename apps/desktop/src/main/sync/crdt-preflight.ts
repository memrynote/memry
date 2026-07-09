import path from 'path'
import { app, utilityProcess } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtPreflight')

const PREFLIGHT_TIMEOUT_MS = 10_000

export interface CrdtPreflightResult {
  ok: boolean
  reason?: string
}

// One preflight per process: a broken binding stays broken, and a passed
// preflight need not re-pay the child-spawn cost on re-init (sign-out/sign-in).
let cached: Promise<CrdtPreflightResult> | null = null

/**
 * Verify the classic-level native binding survives real use — in a disposable
 * utilityProcess, before the main process ever loads it. A binding that
 * hard-aborts (no JS error, no uncaughtException) kills the child, not the
 * app; main then runs the CRDT layer in-memory. See crdt-preflight-child.ts.
 */
export function runCrdtPreflight(): Promise<CrdtPreflightResult> {
  if (!cached) {
    cached = execPreflight().catch((err) => {
      log.error('CRDT preflight failed to run', { error: err })
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    })
  }
  return cached
}

export function resetCrdtPreflightForTests(): void {
  cached = null
}

async function execPreflight(): Promise<CrdtPreflightResult> {
  const probeDir = path.join(app.getPath('userData'), 'crdt-store-preflight')
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
        log.debug('CRDT preflight passed', { elapsedMs: Date.now() - startedAt })
      } else {
        log.error('CRDT store failed preflight — CRDT layer will run in-memory', {
          reason: result.reason,
          stderr: stderr.slice(0, 2000),
          elapsedMs: Date.now() - startedAt
        })
      }
      resolve(result)
    }

    const child = utilityProcess.fork(childPath, [probeDir], {
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
