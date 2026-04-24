import { execSync, type ExecSyncOptions } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ExecFn = (cmd: string, opts: ExecSyncOptions) => Buffer | string | undefined

export interface CheckBindingsResult {
  exitCode: 0 | 1
  drift: boolean
}

/**
 * Regenerates bindings.ts then runs `git diff --exit-code` to assert the
 * checked-in file matches the fresh output. Returns exitCode=1 when git
 * reports drift. Propagates generation failures (compile errors) without
 * converting them to drift.
 *
 * Takes `execFn` as a dependency so it can be mocked in tests.
 */
export function runCheckBindings(
  execFn: ExecFn,
  appRoot: string
): CheckBindingsResult {
  execFn('pnpm bindings:generate', {
    cwd: appRoot,
    stdio: 'inherit'
  })

  try {
    execFn('git diff --exit-code -- src/generated/bindings.ts', {
      cwd: appRoot,
      stdio: 'inherit'
    })
    return { exitCode: 0, drift: false }
  } catch {
    return { exitCode: 1, drift: true }
  }
}

function runCli(): void {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  process.stdout.write('Regenerating bindings.ts and checking for drift...\n')
  const result = runCheckBindings(execSync, appRoot)

  if (result.drift) {
    process.stderr.write('❌ Bindings drift detected\n')
    process.stderr.write('Run `pnpm bindings:generate` and commit the result.\n')
    process.exit(1)
  }

  process.stdout.write('✅ Bindings in sync\n')
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (invokedAsScript) {
  runCli()
}
