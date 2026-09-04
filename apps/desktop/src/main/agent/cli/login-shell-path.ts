import { spawn } from 'node:child_process'
import { basename, delimiter } from 'node:path'

import { createLogger } from '../../lib/logger'
import { trackMainLog } from '../../telemetry/diagnostics'

const logger = createLogger('AgentCli:LoginShellPath')

/**
 * Resolve the user's real login-shell PATH so packaged builds can find CLIs.
 *
 * A macOS/Linux app launched from Finder/Dock inherits only the minimal system
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the shell PATH where user-installed
 * tools live (`~/.local/bin`, `/opt/homebrew/bin`, npm-global, volta, nvm...). So
 * `which claude` / `which codex` fail and Agent Chat greys out those providers
 * even though they're installed. Running the login shell recovers the same PATH
 * the user sees in their terminal, so spawned probes and the CLIs' own `env node`
 * shebangs resolve correctly. `pnpm dev` is launched from a terminal and already
 * has the full PATH, so this is a packaged-only concern.
 *
 * The probe sources the user's whole rc chain, which measured 182 ms on the
 * owner's machine and over a second on a heavier one (#2003). It therefore runs
 * concurrently with boot rather than in front of it: `startLoginShellPathAugmentation`
 * fires it and returns, and every consumer that resolves a binary through PATH
 * awaits `whenLoginShellPathApplied` first so none of them can race the window
 * where PATH is still the minimal one.
 */

/** Unique token prefixed to the printed PATH so we can extract it past rc noise. */
export const PATH_MARKER = '__MEMRY_LOGIN_PATH__'

/** Run the shell probe and hand back its stdout; rejects like `execFile` does. */
export type RunShellProbe = (shell: string, args: string[]) => Promise<string>

/** Pull the PATH out of the shell probe's stdout. */
export function parseShellPath(stdout: string, marker: string = PATH_MARKER): string | null {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.includes(marker))
  if (line === undefined) {
    return null
  }
  const value = line.slice(line.indexOf(marker) + marker.length).trim()
  return value.length > 0 ? value : null
}

/** Merge two PATH strings, resolved entries first, deduped, order-preserving. */
export function mergePaths(
  current: string,
  resolved: string,
  separator: string = delimiter
): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const entry of [...resolved.split(separator), ...current.split(separator)]) {
    if (entry.length > 0 && !seen.has(entry)) {
      seen.add(entry)
      merged.push(entry)
    }
  }
  return merged.join(separator)
}

export const PROBE_TIMEOUT_MS = 3_000

const runShellProbe: RunShellProbe = (shell, args) =>
  new Promise((resolve, reject) => {
    // stdin is closed, not piped. An rc chain that reads stdin blocks forever on
    // an open pipe, and the synchronous probe this replaced handed the shell EOF
    // for free.
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }

    const timer = setTimeout(() => {
      // SIGKILL, not the default SIGTERM: an interactive shell ignores SIGTERM,
      // so the polite signal leaves this promise pending for the whole session
      // and every consumer awaiting the PATH gate hangs with it.
      child.kill('SIGKILL')
      settle(() => reject(Object.assign(new Error('login shell probe timed out'), { code: null })))
    }, PROBE_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', (error) => settle(() => reject(error)))
    child.on('close', (code) => {
      settle(() =>
        code === 0
          ? resolve(stdout)
          : reject(Object.assign(new Error(`login shell exited ${code}`), { code }))
      )
    })
  })

/** Probe the login shell for its PATH; resolves to null on any failure. */
export async function readLoginShellPath(
  run: RunShellProbe = runShellProbe
): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/bash'
  // A silent null here is precisely the failure that greys out Claude/Codex
  // providers in packaged builds — leave a breadcrumb per failure class.
  // Shell basename only, never the full path.
  const probeFailed = (failureClass: string): null => {
    logger.warn(`Login shell PATH probe failed (${basename(shell)}): ${failureClass}`)
    trackMainLog('warn', {
      scope: 'AgentCli',
      action: 'login_shell_path_probe_failed',
      errorCode: failureClass
    })
    return null
  }
  try {
    // `-i` (interactive) so zsh's ~/.zshrc / bash's ~/.bashrc run — that's where
    // PATH is usually set; `-l` (login) so profile files run too.
    const stdout = await run(shell, ['-ilc', `printf '%s\\n' "${PATH_MARKER}$PATH"`])
    const parsed = parseShellPath(stdout)
    if (parsed === null) {
      return probeFailed('marker_missing')
    }
    return parsed
  } catch (error) {
    // A numeric `code` means the shell ran and exited non-zero; a string errno
    // means it never started; `null` is the timeout kill. That keeps the three
    // apart the way the synchronous `result.status` check did.
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'number') return probeFailed(`status_${code}`)
    return probeFailed(code === null ? 'status_none' : 'spawn_error')
  }
}

interface ApplyOptions {
  resolve?: () => Promise<string | null>
  platform?: NodeJS.Platform
  packaged?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * Augment `env.PATH` with the login-shell PATH. No-op unless the app is packaged
 * on a non-Windows platform and the probe succeeds. Resolves to whether PATH changed.
 */
export async function applyLoginShellPath({
  resolve = readLoginShellPath,
  platform = process.platform,
  packaged = false,
  env = process.env
}: ApplyOptions = {}): Promise<boolean> {
  // Windows GUI apps already inherit the system PATH; dev is launched from a
  // terminal with the full PATH, so only packaged macOS/Linux builds need this.
  if (platform === 'win32' || !packaged) {
    return false
  }
  const resolved = await resolve()
  if (!resolved) {
    return false
  }
  const before = env.PATH ?? ''
  const merged = mergePaths(before, resolved)
  if (merged === before) {
    return false
  }
  env.PATH = merged
  return true
}

let augmentation: Promise<boolean> | null = null

/**
 * Start the probe and leave it running. Boot calls this and moves on; repeat
 * calls join the first one rather than spawning a second shell.
 */
export function startLoginShellPathAugmentation(options: ApplyOptions = {}): Promise<boolean> {
  augmentation ??= applyLoginShellPath(options).catch((error: unknown) => {
    logger.warn('Login shell PATH augmentation failed', error)
    return false
  })
  return augmentation
}

/**
 * Settle the augmentation before resolving anything through PATH. A probe that
 * lands inside the window where PATH is still the minimal Finder one reports an
 * installed CLI as missing, which is the greyed-out-provider bug this file exists
 * to prevent. Resolves immediately once the augmentation has finished, and on a
 * build that never started one.
 */
export async function whenLoginShellPathApplied(): Promise<void> {
  await augmentation
}
