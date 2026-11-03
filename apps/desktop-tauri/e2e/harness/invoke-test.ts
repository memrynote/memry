import { randomUUID } from 'node:crypto'

import { HarnessError } from './errors'

/** The slice of a WebdriverIO browser the harness drives. */
export interface Executor {
  execute(script: string, ...args: unknown[]): Promise<unknown>
  executeAsync(script: string, ...args: unknown[]): Promise<unknown>
}

// Not `error`: WebDriver reads a script result with an `error` key as a failed command and sends
// the command again.
interface InvokeOutcome {
  ok: boolean
  value?: unknown
  failure?: unknown
}

const MISSING_TAURI = 'window.__TAURI__ is missing; is this the e2e build?'

// `window.__TAURI__` exists only in the e2e build (`app.withGlobalTauri` of tauri.e2e.conf.json).
const INVOKE_SCRIPT = `
  const [name, args, done] = arguments;
  const tauri = window.__TAURI__;
  if (!tauri) return done({ ok: false, failure: '${MISSING_TAURI}' });
  tauri.core.invoke(name, args).then(
    (value) => done({ ok: true, value: value === undefined ? null : value }),
    (failure) => done({ ok: false, failure })
  );
`

const MARK_SCRIPT = `
  if (!window.__TAURI__) throw new Error('${MISSING_TAURI}');
  window.__memryE2eSendTarget = arguments[0];
`

// Sends only from the marked document: WebDriver resends a call that the death interrupted, and
// the resent copy lands in the next document, which has no mark.
const SEND_SCRIPT = `
  const [mark, name, args] = arguments;
  if (window.__memryE2eSendTarget !== mark) return;
  delete window.__memryE2eSendTarget;
  window.__TAURI__.core.invoke(name, args);
`

function checkName(name: string, caller: string): void {
  if (!/^e2e_[a-z0-9_]+$/.test(name)) {
    throw new HarnessError(`${caller} only calls e2e_<verb>_<noun> commands, got "${name}"`)
  }
}

/**
 * Calls an `e2e_<verb>_<noun>` test command. Any other name is rejected here, because the Rust
 * dispatcher would route it to the typed handler.
 */
export async function invokeTest<T = unknown>(
  app: { executor: Executor },
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  checkName(name, 'invokeTest')
  const outcome = (await app.executor.executeAsync(INVOKE_SCRIPT, name, args)) as InvokeOutcome
  if (!outcome.ok) {
    throw new HarnessError(`${name} failed: ${JSON.stringify(outcome.failure)}`)
  }
  return outcome.value as T
}

/**
 * Sends an `e2e_<verb>_<noun>` command that ends the page or the app, so its reply never returns.
 * The driver reads a script's result after the script ran, so the death can interrupt the send
 * call itself; its outcome says nothing. The spec asserts the death's effect instead.
 */
export async function sendTest(
  app: { executor: Executor },
  name: string,
  args: Record<string, unknown> = {}
): Promise<void> {
  checkName(name, 'sendTest')
  const mark = randomUUID()
  await app.executor.execute(MARK_SCRIPT, mark)
  await app.executor.execute(SEND_SCRIPT, mark, name, args).catch(() => undefined)
}
