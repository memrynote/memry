// The page the film scenes drive: the e2e harness's Playwright adapter (pw-compat) over the
// WebDriver server of a running test-mode app (`apps/desktop-tauri/scripts/agent-app.mjs start`),
// limited to the calls the scenes use. Any other call throws `NotInSubset: <call>`, so a scene
// fails at the call it makes instead of driving the app wrong.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { tsImport } from 'tsx/esm/api'

import { createClient } from '../../apps/desktop-tauri/scripts/lib/webdriver-client.mjs'

// pw-compat is TypeScript with parameter properties and extensionless imports, which Node's type
// stripping cannot load. tsx loads it as it is, with no build step and no `--import` flag.
const { Page } = await tsImport(
  '../../apps/desktop-tauri/e2e/harness/pw-compat/page.ts',
  import.meta.url
)

export const DEFAULT_PORT = 9222
const NAVIGATION_TIMEOUT_MS = 20_000
const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.md': 'text/markdown',
  '.txt': 'text/plain'
}

export class NotInSubset extends Error {
  /** @param {string} call */
  constructor(call) {
    super(`NotInSubset: ${call}`)
    this.name = 'NotInSubset'
    this.call = call
  }
}

const QUERIES = [
  'locator',
  'getByRole',
  'getByText',
  'getByTestId',
  'getByPlaceholder',
  'getByLabel'
]

/**
 * The Playwright calls of the scenes under marketing/ (issue #3557's scan of the 71 clips, plus
 * the locator reads the shared kit.mjs helpers make).
 */
export const SUBSET = {
  page: [
    ...QUERIES,
    'evaluate',
    'waitForTimeout',
    'waitForFunction',
    'screenshot',
    'goto',
    'addStyleTag',
    'waitForEvent',
    'keyboard',
    'mouse'
  ],
  keyboard: ['press', 'type', 'insertText', 'down', 'up'],
  mouse: ['move', 'down', 'up', 'wheel', 'click'],
  locator: [
    ...QUERIES,
    'click',
    'waitFor',
    'boundingBox',
    'first',
    'last',
    'nth',
    'count',
    'filter',
    'scrollIntoViewIfNeeded',
    'hover',
    'fill',
    'isVisible',
    'textContent',
    'getAttribute',
    'allTextContents',
    'evaluate',
    'evaluateAll'
  ]
}

// Playwright's selector engines and pseudo-classes beyond the `:has-text`, `:text` and `:visible`
// that pw-compat's CSS adds.
const PLAYWRIGHT_SELECTOR =
  /^(xpath|text|id|data-testid|internal:[a-z-]+)=|>>|:text-(is|matches)\(|:nth-match\(|:left-of\(|:right-of\(|:above\(|:below\(|:near\(/

const optionKeys =
  (name, allowed) =>
  ([, options = {}]) =>
    Object.keys(options)
      .filter((key) => !allowed.includes(key))
      .map((key) => `${name}({ ${key} })`)

/** Arguments pw-compat would take and silently ignore or misread. */
const ARGUMENT_CHECKS = {
  filter: ([options = {}]) =>
    Object.keys(options)
      .filter((key) => key !== 'hasText' && key !== 'hasNotText')
      .map((key) => `filter({ ${key} })`),
  locator: ([selector, options]) =>
    PLAYWRIGHT_SELECTOR.test(selector) || options !== undefined
      ? [`locator(${JSON.stringify(selector)}${options === undefined ? '' : ', options'})`]
      : [],
  getByRole: optionKeys('getByRole', ['name', 'exact']),
  getByText: optionKeys('getByText', ['exact']),
  getByLabel: optionKeys('getByLabel', ['exact']),
  getByPlaceholder: optionKeys('getByPlaceholder', ['exact'])
}

const isLocator = (value) =>
  value !== null && typeof value === 'object' && 'spec' in value && 'core' in value

/**
 * Lets through the `allowed` members of `target`. A member named in SUBSET (`keyboard`, `mouse`)
 * is guarded with its own list, and a locator a call returns is guarded as a locator.
 */
export function guard(target, allowed, name) {
  const names = new Set(allowed)
  return new Proxy(target, {
    get(object, prop) {
      // `await` and a promise that resolves to this object read `then`; it must not throw.
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      if (prop === 'toString') return () => object.toString()
      if (!names.has(prop)) throw new NotInSubset(`${name}.${prop}`)
      const value = object[prop]
      if (typeof value === 'object' && SUBSET[prop])
        return guard(value, SUBSET[prop], `${name}.${prop}`)
      if (typeof value !== 'function') return value
      return (...args) => {
        const [unsupported] = ARGUMENT_CHECKS[prop]?.(args) ?? []
        if (unsupported) throw new NotInSubset(`${name}.${unsupported}`)
        const result = value.apply(object, args)
        return isLocator(result) ? guard(result, SUBSET.locator, 'locator') : result
      }
    }
  })
}

/** pw-compat's Page with the two calls it lacks and `mouse.move`'s `steps`. */
class FilmPage extends Page {
  constructor(browser) {
    super(browser)
    const move = this.mouse.move.bind(this.mouse)
    this.mouse.move = async (x, y, { steps = 1 } = {}) => {
      const { mouseX, mouseY } = this.core
      for (let step = 1; step <= steps; step += 1) {
        await move(mouseX + ((x - mouseX) * step) / steps, mouseY + ((y - mouseY) * step) / steps)
      }
    }
  }

  async addStyleTag({ content } = {}) {
    if (typeof content !== 'string') throw new NotInSubset('page.addStyleTag without content')
    await this.core.evaluate((css) => {
      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
    }, content)
  }

  /**
   * Only `filechooser`: the next file input the page opens is caught in the page instead of
   * showing the OS panel, which WebDriver cannot drive, and `setFiles` hands it the files.
   * Call it before the click that opens the chooser, as with Playwright.
   */
  async waitForEvent(event, { timeout = NAVIGATION_TIMEOUT_MS } = {}) {
    if (event !== 'filechooser') throw new NotInSubset(`page.waitForEvent('${event}')`)
    await this.core.evaluate(() => {
      // null: armed; an input: caught; undefined: inputs open the OS panel as usual.
      window.__memryFilmChooser = null
      if (window.__memryFilmChooserHooked) return
      window.__memryFilmChooserHooked = true
      const proto = HTMLInputElement.prototype
      for (const name of ['click', 'showPicker']) {
        const original = proto[name]
        if (!original) continue
        proto[name] = function (...args) {
          if (this.type === 'file' && window.__memryFilmChooser === null) {
            window.__memryFilmChooser = this
            return undefined
          }
          return original.apply(this, args)
        }
      }
    })
    const deadline = Date.now() + timeout
    while (
      !(await this.core.evaluate(() => window.__memryFilmChooser instanceof HTMLInputElement))
    ) {
      if (Date.now() >= deadline) throw new Error(`no file chooser opened within ${timeout} ms`)
      await new Promise((done) => setTimeout(done, 50))
    }
    return {
      setFiles: async (files) => {
        const items = [files].flat().map((file) => ({
          name: basename(file),
          type: MIME[extname(file).toLowerCase()] ?? '',
          data: readFileSync(file).toString('base64')
        }))
        await this.core.evaluate((list) => {
          const input = window.__memryFilmChooser
          window.__memryFilmChooser = undefined
          const transfer = new DataTransfer()
          for (const { name, type, data } of list) {
            const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
            transfer.items.add(new File([bytes], name, { type }))
          }
          input.files = transfer.files
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }, items)
      }
    }
  }

  /** Navigates the webview and resolves once the new document has loaded. */
  async goto(url) {
    const { browser } = this.core
    const mark = `${Date.now()}-${Math.random()}`
    // The script returns before the navigation starts, so its answer is not lost to the unload.
    await browser.execute(
      'window.__memryFilmDocument = arguments[0]; setTimeout(() => location.assign(arguments[1]), 0)',
      mark,
      url
    )
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS
    for (;;) {
      const loaded = await browser
        .execute(
          "return window.__memryFilmDocument !== arguments[0] && document.readyState === 'complete'",
          mark
        )
        .catch(() => false)
      if (loaded === true) return
      if (Date.now() >= deadline) throw new Error(`goto ${url}: no new document within 20 s`)
      await new Promise((done) => setTimeout(done, 100))
    }
  }
}

const unsupported = (call) => () => Promise.reject(new NotInSubset(call))

/** The PwBrowser surface pw-compat drives, over one session of `webdriver-client.mjs`. */
export function webdriverBrowser(client, sessionId) {
  return {
    execute: (script, ...args) => client.execute(sessionId, script, args),
    executeAsync: (script, ...args) => client.executeAsync(sessionId, script, args),
    performActions: (actions) => client.performActions(sessionId, actions),
    releaseActions: () => client.releaseActions(sessionId),
    takeScreenshot: async () => (await client.screenshot(sessionId)).toString('base64'),
    getUrl: () => client.execute(sessionId, 'return location.href', []),
    getTitle: () => client.execute(sessionId, 'return document.title', []),
    refresh: unsupported('page.reload'),
    setTimeout: unsupported('page.reload')
  }
}

/** The guarded page over a PwBrowser. */
export const wrapPage = (browser) => guard(new FilmPage(browser), SUBSET.page, 'page')

/** The session `agent-app.mjs start` saved for `port`, if any. */
function savedSession(port) {
  try {
    const state = JSON.parse(readFileSync(join(tmpdir(), 'memry-agent-app-tauri.json'), 'utf8'))
    return state.port === port ? state.sessionId : undefined
  } catch {
    return undefined
  }
}

/**
 * Attaches to the running app. Reuses agent-app's session when it still answers, otherwise opens
 * one and deletes it on `browser.close()`. `browser.client` and `browser.sessionId` are for the
 * screen recorder, which places and measures the window.
 */
export async function connect({
  port = Number(process.env.TAURI_WEBDRIVER_PORT ?? DEFAULT_PORT)
} = {}) {
  const client = createClient(`http://127.0.0.1:${port}`)
  let sessionId = savedSession(port)
  let owned = false
  if (sessionId) {
    try {
      await client.windowHandles(sessionId)
    } catch {
      sessionId = undefined
    }
  }
  if (!sessionId) {
    sessionId = await client.newSession()
    owned = true
  }
  const browser = {
    client,
    sessionId,
    close: async () => {
      if (owned) await client.deleteSession(sessionId)
    }
  }
  return { browser, page: wrapPage(webdriverBrowser(client, sessionId)) }
}
