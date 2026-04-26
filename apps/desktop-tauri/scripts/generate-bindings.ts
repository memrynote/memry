import { execSync, type ExecSyncOptions } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ExecFn = (cmd: string, opts: ExecSyncOptions) => Buffer | string | undefined

export interface GenerateBindingsResult {
  exitCode: 0
}

/**
 * Runs `cargo run --example generate_bindings --quiet` inside src-tauri/, which
 * regenerates `src/generated/bindings.ts` from the Rust command surface.
 * Uses an example target (not a bin) so tauri-bundler does not try to copy
 * the dev-only binary into the production .app bundle.
 *
 * Takes `execFn` as a dependency so it can be mocked in tests without spawning
 * real subprocesses.
 */
export function runGenerateBindings(
  execFn: ExecFn,
  appRoot: string
): GenerateBindingsResult {
  execFn('cargo run --example generate_bindings --quiet', {
    cwd: resolve(appRoot, 'src-tauri'),
    stdio: 'inherit'
  })
  return { exitCode: 0 }
}

function runCli(): void {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  process.stdout.write('Running cargo to regenerate bindings.ts...\n')
  runGenerateBindings(execSync, appRoot)
  process.stdout.write('✅ Bindings regenerated\n')
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (invokedAsScript) {
  runCli()
}
