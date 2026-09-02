import { execFileSync } from 'node:child_process'

/**
 * Runs an ESM module body in a real child `node` process with `TZ` set to `tz`, and parses its
 * stdout as JSON.
 *
 * Vitest's renderer project runs on the `threads` pool, where `process.env` is a per-worker copy:
 * assigning `process.env.TZ` at runtime never reaches the C++ `tzset` that would move the clock,
 * so the process stays pinned to the host's zone no matter what the test sets. A child process is
 * the only way to prove timezone-dependent code on a CI runner that sits at UTC, where a timezone
 * bug and its fix can otherwise look identical.
 *
 * `script` must end with `process.stdout.write(JSON.stringify(result))`. Any module it imports by
 * path must itself be import-free (or import only other import-free modules) — bare `node` type-
 * strips on import but does not resolve the project's path aliases or extensionless specifiers.
 */
export function runInTz<T>(tz: string, script: string): T {
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8'
  })
  return JSON.parse(out) as T
}
