import { spawnSync } from 'node:child_process'
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
 */

/** Unique token prefixed to the printed PATH so we can extract it past rc noise. */
export const PATH_MARKER = '__MEMRY_LOGIN_PATH__'

type SpawnSync = typeof spawnSync

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

/** Probe the login shell for its PATH; returns null on any failure. */
export function readLoginShellPath(spawn: SpawnSync = spawnSync): string | null {
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
    const result = spawn(shell, ['-ilc', `printf '%s\\n' "${PATH_MARKER}$PATH"`], {
      encoding: 'utf8',
      timeout: 3000
    })
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
      return probeFailed(`status_${result?.status ?? 'none'}`)
    }
    const parsed = parseShellPath(result.stdout)
    if (parsed === null) {
      return probeFailed('marker_missing')
    }
    return parsed
  } catch {
    return probeFailed('spawn_error')
  }
}

interface ApplyOptions {
  resolve?: () => string | null
  platform?: NodeJS.Platform
  packaged?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * Augment `env.PATH` with the login-shell PATH. No-op unless the app is packaged
 * on a non-Windows platform and the probe succeeds. Returns whether PATH changed.
 */
export function applyLoginShellPath({
  resolve = readLoginShellPath,
  platform = process.platform,
  packaged = false,
  env = process.env
}: ApplyOptions = {}): boolean {
  // Windows GUI apps already inherit the system PATH; dev is launched from a
  // terminal with the full PATH, so only packaged macOS/Linux builds need this.
  if (platform === 'win32' || !packaged) {
    return false
  }
  const resolved = resolve()
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
