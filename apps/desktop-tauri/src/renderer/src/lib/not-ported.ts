import { createLogger } from './logger'

const log = createLogger('NotPorted')
const SUBSCRIBE_NAME = /^on[A-Z]/

export class NotPortedError extends Error {
  constructor(callPath: string) {
    super(`${callPath} is not ported`)
    this.name = 'NotPortedError'
  }
}

const loggedSubscriptions = new Set<string>()

const noopUnsubscribe = (): void => undefined

// A function target, so a leaf can be called; `get` hands out the next level.
function createLevel(callPath: string, name: string): unknown {
  return new Proxy(() => undefined, {
    get(_target, property) {
      // Symbols and `then` must stay undefined, or `await window.api` would treat the proxy
      // as a thenable and never settle.
      if (typeof property === 'symbol' || property === 'then') return undefined
      // `fn.call(thisArg, ...)` and friends are the function's own, not a deeper path.
      if (property === 'call' || property === 'apply' || property === 'bind') {
        return Function.prototype[property]
      }
      return createLevel(`${callPath}.${property}`, property)
    },
    apply() {
      if (SUBSCRIBE_NAME.test(name)) {
        if (!loggedSubscriptions.has(callPath)) {
          loggedSubscriptions.add(callPath)
          log.info(`${callPath} subscribed; no events arrive until it is ported`)
        }
        return noopUnsubscribe
      }
      // Every `window.api` call is async IPC in Electron, so a caller handles a rejection
      // (`await`, `.catch`). A synchronous throw escaped them and blanked the whole window at
      // boot, which hid every ported domain behind the first unported one.
      return Promise.reject(new NotPortedError(callPath))
    }
  })
}

/**
 * Defines `window.api` and `window.electron` as nested proxies for the development build.
 * Calling a leaf returns a promise rejected with `NotPortedError`; an `onXxx` leaf returns a no-op unsubscribe function
 * and logs once per name. Step 43 (#3560) deletes this file.
 */
/** What the shim is installed on: `window`, or a stand-in in tests. */
export interface NotPortedHost {
  api?: unknown
  electron?: unknown
}

export function installNotPortedShim(target: NotPortedHost = window): void {
  for (const root of ['api', 'electron']) {
    Object.defineProperty(target, root, {
      value: createLevel(`window.${root}`, root),
      configurable: true,
      writable: true
    })
  }
}
