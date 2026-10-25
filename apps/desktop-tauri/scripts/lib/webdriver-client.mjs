// A small W3C WebDriver client for the embedded server of `tauri-plugin-wdio-webdriver`, which
// binds 127.0.0.1 only. Plain ESM on the global `fetch`, so `agent-app.mjs`, `webdriver-mcp.mjs`
// and the VM `wd.mjs` import it without a build step.

/** The W3C identifier of a web element in a command result. */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

/** A failed WebDriver call; carries the W3C `error` code and its `message`. */
export class WebDriverError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'WebDriverError'
    this.error = code
    this.detail = message
  }
}

const sessionPath = (/** @type {string} */ id, /** @type {string} */ path = '') =>
  `/session/${encodeURIComponent(id)}${path}`

/**
 * @param {string} baseUrl e.g. `http://127.0.0.1:9222`
 */
export function createClient(baseUrl) {
  const root = baseUrl.replace(/\/+$/, '')

  /**
   * @param {'GET' | 'POST' | 'DELETE'} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>} the `value` of the response
   */
  async function call(method, path, body) {
    let response
    try {
      response = await fetch(
        `${root}${path}`,
        body === undefined
          ? { method }
          : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      )
    } catch (cause) {
      throw new WebDriverError('unreachable', `${method} ${root}${path}: ${String(cause)}`)
    }
    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new WebDriverError('invalid response', `HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    const value = payload?.value
    // A script may answer `{ ok: false, error }` with status 200; only the status marks a failure.
    if (!response.ok) {
      throw new WebDriverError(
        value?.error ?? `http ${response.status}`,
        value?.message ?? text.slice(0, 200)
      )
    }
    return value
  }

  return {
    baseUrl: root,
    status: () => call('GET', '/status'),
    /** @returns {Promise<string>} the new session id */
    async newSession() {
      const value = await call('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'tauri' } }
      })
      return value.sessionId
    },
    deleteSession: (/** @type {string} */ id) => call('DELETE', sessionPath(id)),
    execute: (id, script, args = []) =>
      call('POST', sessionPath(id, '/execute/sync'), { script, args }),
    executeAsync: (id, script, args = []) =>
      call('POST', sessionPath(id, '/execute/async'), { script, args }),
    /** @returns {Promise<Buffer>} PNG bytes */
    async screenshot(id) {
      return Buffer.from(await call('GET', sessionPath(id, '/screenshot')), 'base64')
    },
    /** @returns {Promise<Buffer>} PNG bytes */
    async elementScreenshot(id, elementId) {
      return Buffer.from(
        await call('GET', sessionPath(id, `/element/${elementId}/screenshot`)),
        'base64'
      )
    },
    currentWindow: (id) => call('GET', sessionPath(id, '/window')),
    windowHandles: (id) => call('GET', sessionPath(id, '/window/handles')),
    switchWindow: (id, handle) => call('POST', sessionPath(id, '/window'), { handle }),
    /** @returns {Promise<string>} the element id */
    async findElement(id, css) {
      const value = await call('POST', sessionPath(id, '/element'), {
        using: 'css selector',
        value: css
      })
      return value[ELEMENT_KEY]
    },
    elementRect: (id, elementId) => call('GET', sessionPath(id, `/element/${elementId}/rect`)),
    performActions: (id, actions) => call('POST', sessionPath(id, '/actions'), { actions }),
    releaseActions: (id) => call('DELETE', sessionPath(id, '/actions'))
  }
}
