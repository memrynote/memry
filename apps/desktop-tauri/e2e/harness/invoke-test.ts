import { HarnessError } from './errors'

/** The slice of a WebdriverIO browser the harness drives. */
export interface Executor {
  execute(script: string, ...args: unknown[]): Promise<unknown>
  executeAsync(script: string, ...args: unknown[]): Promise<unknown>
}

interface InvokeOutcome {
  ok: boolean
  value?: unknown
  error?: unknown
}

// `window.__TAURI__` exists only in the e2e build (`app.withGlobalTauri` of tauri.e2e.conf.json).
const INVOKE_SCRIPT = `
  const [name, args, done] = arguments;
  const tauri = window.__TAURI__;
  if (!tauri) return done({ ok: false, error: 'window.__TAURI__ is missing; is this the e2e build?' });
  tauri.core.invoke(name, args).then(
    (value) => done({ ok: true, value: value === undefined ? null : value }),
    (error) => done({ ok: false, error })
  );
`

/**
 * Calls an `e2e_<verb>_<noun>` test command. Any other name is rejected here, because the Rust
 * dispatcher would route it to the typed handler.
 */
export async function invokeTest<T = unknown>(
  app: { executor: Executor },
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  if (!/^e2e_[a-z0-9_]+$/.test(name)) {
    throw new HarnessError(`invokeTest only calls e2e_<verb>_<noun> commands, got "${name}"`)
  }
  const outcome = (await app.executor.executeAsync(INVOKE_SCRIPT, name, args)) as InvokeOutcome
  if (!outcome.ok) {
    throw new HarnessError(`${name} failed: ${JSON.stringify(outcome.error)}`)
  }
  return outcome.value as T
}
