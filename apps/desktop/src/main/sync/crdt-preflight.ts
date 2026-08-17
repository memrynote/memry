import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import { utilityProcess } from 'electron'
import { createLogger } from '../lib/logger'
import {
  PREFLIGHT_MARK_BINDING_LOADED,
  PREFLIGHT_MARK_STARTED,
  type CrdtPreflightStage
} from './crdt-preflight-protocol'

const log = createLogger('CrdtPreflight')

const PREFLIGHT_TIMEOUT_MS = 10_000
// The interesting part of a native abort is the first crash banner; keep
// enough of it to identify the failing subsystem in log aggregation.
const STDERR_CAPTURE_CHARS = 4096

export type { CrdtPreflightStage }

export interface CrdtPreflightResult {
  ok: boolean
  reason?: string
  /** How far the child got before failing. Only meaningful when `ok` is false. */
  stage?: CrdtPreflightStage
  /**
   * Which child transport produced this verdict. Reported as telemetry: a
   * `node` verdict means the Chromium-free fallback ALSO failed, which is the
   * difference between "the utility process can't boot on this machine" (we
   * recover) and "the binding is broken for this machine" (we don't).
   */
  transport?: Transport
}

export type Transport = 'utility' | 'node'

/** The bits of UtilityProcess and ChildProcess this module actually uses. */
interface ProbeChild {
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  kill(): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Verify the classic-level native binding survives real use — in a disposable
 * child process, before the main process ever loads it. The child probes the
 * REAL store directory, so both a binding that hard-aborts (no JS error, no
 * uncaughtException) and a store whose on-disk state aborts the binding (torn
 * LDB/MANIFEST from a past crash) kill the child, not the app.
 *
 * Two transports, because the utilityProcess itself can be the thing that
 * fails: on a set of Windows installs it dies during Chromium/crashpad init
 * (exit `0xFFFF7003`) before any of our JS runs, which used to read as "the
 * store is bad" and left those machines in-memory forever. When the child
 * never reaches its `started` marker, the same probe is retried as a plain
 * node child (`ELECTRON_RUN_AS_NODE`), which boots no Chromium and no crash
 * handler — same process isolation, none of the Chromium startup surface.
 *
 * No verdict cache: the provider latches init (persistenceReady) so a verdict
 * is only ever requested again after it quarantined the store — and that retry
 * must genuinely re-probe. See crdt-preflight-child.ts and crdt-provider.ts.
 */
export async function runCrdtPreflight(storeDir: string): Promise<CrdtPreflightResult> {
  return await probeWithFallback(storeDir).catch((err) => {
    log.error('CRDT preflight failed to run', { error: err })
    return {
      ok: false,
      stage: 'bootstrap' as const,
      reason: err instanceof Error ? err.message : String(err)
    }
  })
}

async function probeWithFallback(storeDir: string): Promise<CrdtPreflightResult> {
  const startedAt = Date.now()
  let result = await execPreflight(storeDir, 'utility')

  if (!result.ok && result.stage === 'bootstrap') {
    log.warn('CRDT preflight child never started — retrying without Chromium', {
      reason: result.reason,
      platform: process.platform,
      osRelease: os.release()
    })
    result = await execPreflight(storeDir, 'node')
  }

  if (result.ok) {
    log.debug('CRDT preflight passed', { storeDir, elapsedMs: Date.now() - startedAt })
  } else {
    log.error('CRDT store failed preflight — CRDT layer will run in-memory', {
      storeDir,
      reason: result.reason,
      stage: result.stage,
      platform: process.platform,
      osRelease: os.release(),
      elapsedMs: Date.now() - startedAt
    })
  }
  return result
}

async function execPreflight(storeDir: string, transport: Transport): Promise<CrdtPreflightResult> {
  const childPath = path.join(__dirname, 'crdt-preflight-child.js')

  // Stamped once on the way out rather than at each settle site below — every
  // verdict in this promise came from this transport, and there are five ways
  // to reach one.
  const result = await new Promise<CrdtPreflightResult>((resolve) => {
    let settled = false
    let stderr = ''

    const stageFromMarkers = (): CrdtPreflightStage => {
      if (stderr.includes(PREFLIGHT_MARK_BINDING_LOADED)) return 'store'
      if (stderr.includes(PREFLIGHT_MARK_STARTED)) return 'binding'
      return 'bootstrap'
    }

    const settle = (result: CrdtPreflightResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result.ok) {
        log.warn('CRDT preflight child failed', {
          transport,
          storeDir,
          reason: result.reason,
          stage: result.stage,
          stderr: stderr.slice(0, STDERR_CAPTURE_CHARS)
        })
      }
      resolve(result)
    }

    let child: ProbeChild
    try {
      child = fork(childPath, storeDir, transport)
    } catch (err) {
      // Never reached JS, so the store is not a suspect.
      resolve({
        ok: false,
        stage: 'bootstrap',
        reason: err instanceof Error ? err.message : String(err)
      })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      settle({
        ok: false,
        stage: stageFromMarkers(),
        reason: `timed out after ${PREFLIGHT_TIMEOUT_MS}ms`
      })
    }, PREFLIGHT_TIMEOUT_MS)

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err: Error) => {
      settle({ ok: false, stage: stageFromMarkers(), reason: err.message })
    })

    child.once('exit', (code: number | null) => {
      if (code === 0) {
        settle({ ok: true })
        return
      }
      // Log the code in hex too: Windows reports these as huge unsigned
      // values (0xFFFF7003 = 4294930435) that are meaningless in decimal.
      const hex = typeof code === 'number' ? ` (0x${(code >>> 0).toString(16).toUpperCase()})` : ''
      settle({
        ok: false,
        stage: stageFromMarkers(),
        reason: `child exited with code ${code}${hex}`
      })
    })
  })

  return { ...result, transport }
}

function fork(childPath: string, storeDir: string, transport: Transport): ProbeChild {
  if (transport === 'node') {
    // Same binary, no Chromium: ELECTRON_RUN_AS_NODE boots plain node, so the
    // crashpad/sandbox startup path that kills the utility child is not run.
    return spawn(process.execPath, [childPath, storeDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    }) as unknown as ProbeChild
  }

  return utilityProcess.fork(childPath, [storeDir], {
    // Label the fork so a native abort here surfaces as 'CrdtPreflight' in
    // `ps` and child-process-gone telemetry instead of an anonymous
    // 'Node Utility Process' (the long-lived workers already set this).
    serviceName: 'CrdtPreflight',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env }
  }) as unknown as ProbeChild
}
