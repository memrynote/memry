import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { promisify } from 'node:util'

import type { BinaryStatus } from '@memry/contracts/ipc-agent'

import { whenLoginShellPathApplied } from './login-shell-path'

const execFileAsync = promisify(execFile)

/**
 * How long a *usable* detection is trusted before it is probed again.
 *
 * Deliberately bounded rather than cached for the whole session: the CLI can be
 * uninstalled or moved while the app runs, and a stale "available" answer turns
 * a friendly install hint into a raw spawn failure. A few minutes is long
 * enough that a burst of turns, titles and summaries share one probe.
 */
export const BINARY_DETECTION_TTL_MS = 5 * 60 * 1000

/**
 * Run a command without blocking the main-process event loop.
 *
 * Returns `null` on a non-zero exit or a spawn failure, mirroring the
 * `status !== 0` checks the synchronous probes used to do.
 */
export async function runBinaryCommand(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string } | null> {
  // A packaged launch starts with the minimal Finder PATH and augments it from
  // the login shell in the background (#2003). Probing inside that window would
  // report an installed CLI as missing, so wait the augmentation out first.
  await whenLoginShellPathApplied()
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { encoding: 'utf8' })
    return { stdout, stderr }
  } catch {
    return null
  }
}

/** Resolve an executable on PATH, or `null` when it is not installed. */
export async function locateBinary(name: string): Promise<string | null> {
  const which = platform() === 'win32' ? 'where' : 'which'
  const result = await runBinaryCommand(which, [name])
  if (!result) {
    return null
  }

  const binaryPath = result.stdout.split(/\r?\n/).filter(Boolean)[0]
  if (!binaryPath || !existsSync(binaryPath)) {
    return null
  }

  return binaryPath
}

/**
 * Wrap a binary probe so repeated callers share one spawn.
 *
 * Two guarantees matter more than the caching itself:
 * - Concurrent callers await the *same* in-flight probe, so a turn and a status
 *   query never race into two spawns (or into a premature "no binary").
 * - A miss is never remembered. The CLI has twice been reported as greyed out
 *   for reasons the user can fix mid-session (a packaged-app PATH gap, a
 *   keychain mismatch); memoising "not found" would make those permanent for
 *   the rest of the session instead of clearing on the next call.
 */
export function cacheBinaryDetection(
  probe: () => Promise<BinaryStatus>
): () => Promise<BinaryStatus> {
  let cached: { status: BinaryStatus; expiresAt: number } | null = null
  let inFlight: Promise<BinaryStatus> | null = null

  return async () => {
    if (cached && cached.expiresAt > Date.now()) {
      return cached.status
    }
    cached = null
    if (inFlight) {
      return inFlight
    }

    const pending = probe().then(
      (status) => {
        inFlight = null
        cached =
          status.detected && status.meetsMinimum
            ? { status, expiresAt: Date.now() + BINARY_DETECTION_TTL_MS }
            : null
        return status
      },
      (error: unknown) => {
        inFlight = null
        throw error
      }
    )
    inFlight = pending
    return pending
  }
}
