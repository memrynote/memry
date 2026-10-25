import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { HarnessError } from '../errors'
import { sleep } from '../wait'
import { type MouseButton, PageCore, type PwBrowser } from './driver'
import { keyToCodepoint } from './keys'
import { Locator } from './locator'
import { type ByRoleOptions, type TextOptions, rootSpec } from './selector-spec'

class Keyboard {
  constructor(private readonly core: PageCore) {}

  press(combo: string, options: { delay?: number } = {}): Promise<void> {
    void options
    return this.core.press(combo)
  }
  type(text: string): Promise<void> {
    return this.core.typeText(text)
  }
  down(key: string): Promise<void> {
    return this.core.keys([{ type: 'keyDown', value: keyToCodepoint(key) }])
  }
  up(key: string): Promise<void> {
    return this.core.keys([{ type: 'keyUp', value: keyToCodepoint(key) }])
  }
  /** Inserts text at the focus without key events, as Playwright's `insertText`. */
  async insertText(text: string): Promise<void> {
    await this.core.evaluate(
      (value: string) => document.execCommand('insertText', false, value),
      text
    )
  }
}

class Mouse {
  constructor(private readonly core: PageCore) {}

  move(x: number, y: number): Promise<void> {
    return this.core.moveMouse(x, y)
  }
  down(options: { button?: MouseButton } = {}): Promise<void> {
    return this.core.mouseDown(options.button ?? 'left')
  }
  up(options: { button?: MouseButton } = {}): Promise<void> {
    return this.core.mouseUp(options.button ?? 'left')
  }
  click(
    x: number,
    y: number,
    options: { button?: MouseButton; clickCount?: number } = {}
  ): Promise<void> {
    return this.core.clickAt(x, y, options)
  }
  dblclick(x: number, y: number, options: { button?: MouseButton } = {}): Promise<void> {
    return this.core.clickAt(x, y, { ...options, clickCount: 2 })
  }
  wheel(deltaX: number, deltaY: number): Promise<void> {
    return this.core.wheel(deltaX, deltaY)
  }
}

/** The Playwright `Page` surface the ported specs use, over a WebdriverIO browser. */
export class Page {
  readonly core: PageCore
  readonly keyboard: Keyboard
  readonly mouse: Mouse

  constructor(browser: PwBrowser) {
    this.core = new PageCore(browser)
    this.keyboard = new Keyboard(this.core)
    this.mouse = new Mouse(this.core)
  }

  private root(): Locator {
    return new Locator(this.core, rootSpec)
  }

  locator(selector: string): Locator {
    return this.root().locator(selector)
  }
  getByRole(role: string, options?: ByRoleOptions): Locator {
    return this.root().getByRole(role, options)
  }
  getByTestId(id: string): Locator {
    return this.root().getByTestId(id)
  }
  getByText(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByText(text, options)
  }
  getByLabel(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByLabel(text, options)
  }
  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByPlaceholder(text, options)
  }

  evaluate<T>(fn: (arg: any) => T | Promise<T>, arg?: unknown): Promise<T> {
    return this.core.evaluate<T>(fn, arg)
  }

  async waitForFunction(
    fn: (arg: any) => unknown,
    arg?: unknown,
    { timeout = this.core.timeoutMs, polling = 100 }: { timeout?: number; polling?: number } = {}
  ): Promise<void> {
    const deadline = Date.now() + timeout
    for (;;) {
      if (await this.core.evaluate<unknown>(fn, arg)) return
      if (Date.now() >= deadline)
        throw new HarnessError(`waitForFunction timed out after ${timeout} ms`)
      await sleep(polling)
    }
  }

  /** Resolves once `document.readyState` has reached the requested stage. */
  async waitForLoadState(
    state: 'domcontentloaded' | 'load' | 'networkidle' = 'load',
    { timeout = this.core.timeoutMs }: { timeout?: number } = {}
  ): Promise<void> {
    const reached = state === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete']
    await this.waitForFunction(
      (states: string[]) => states.includes(document.readyState),
      reached,
      {
        timeout
      }
    )
  }

  waitForTimeout(ms: number): Promise<void> {
    return sleep(ms)
  }

  async reload(): Promise<void> {
    await this.core.browser.refresh()
  }

  /**
   * Runs `fn(arg)` now, then reloads. WebDriver has no script that runs before first paint, and
   * the ported specs only seed `localStorage` with it, which the reload makes the app read.
   */
  async addInitScript(fn: (arg: any) => unknown, arg?: unknown): Promise<void> {
    await this.core.evaluate(fn, arg)
    await this.reload()
  }

  url(): Promise<string> {
    return this.core.browser.getUrl()
  }
  title(): Promise<string> {
    return this.core.browser.getTitle()
  }

  async screenshot(options: { path?: string; fullPage?: boolean } = {}): Promise<Buffer> {
    const png = Buffer.from(await this.core.browser.takeScreenshot(), 'base64')
    if (options.path) {
      mkdirSync(dirname(options.path), { recursive: true })
      writeFileSync(options.path, png)
    }
    return png
  }

  setDefaultTimeout(ms: number): void {
    this.core.timeoutMs = ms
  }
}
