import { EXPECT_TIMEOUT_MS } from '../budgets'
import { HarnessError } from '../errors'
import { sleep } from '../wait'
import { INSTALL_SCRIPT } from './in-page.mjs'
import { type KeyAction, pressActions, typeActions } from './keys'
import { type LocatorSpec } from './selector-spec'

/** The slice of a WebdriverIO browser the adapter drives. */
export interface PwBrowser {
  execute(script: string, ...args: unknown[]): Promise<unknown>
  executeAsync(script: string, ...args: unknown[]): Promise<unknown>
  performActions(actions: unknown[]): Promise<void>
  releaseActions(): Promise<void>
  takeScreenshot(): Promise<string>
  refresh(): Promise<void>
  getUrl(): Promise<string>
  getTitle(): Promise<string>
}

export type MouseButton = 'left' | 'middle' | 'right'
const BUTTON_INDEX: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 }

export interface TargetState {
  count: number
  visible?: boolean
  enabled?: boolean
  hit?: boolean
  box?: { x: number; y: number; width: number; height: number }
  x?: number
  y?: number
}

/** Shared state of one page: the browser, the pointer position and the time budget. */
export class PageCore {
  mouseX = 0
  mouseY = 0
  timeoutMs = EXPECT_TIMEOUT_MS

  constructor(readonly browser: PwBrowser) {}

  /** Calls `window.__memryPw.<method>(...args)`, installing the helpers on first use. */
  async pw<T>(method: string, ...args: unknown[]): Promise<T> {
    return (await this.browser.execute(
      `${INSTALL_SCRIPT}; return window.__memryPw.${method}(...arguments);`,
      ...args
    )) as T
  }

  /** Like [`pw`], for a helper that returns a promise. */
  async pwAsync<T>(method: string, ...args: unknown[]): Promise<T> {
    return (await this.browser.executeAsync(
      `${INSTALL_SCRIPT}
       const args = Array.prototype.slice.call(arguments);
       const done = args.pop();
       Promise.resolve(window.__memryPw.${method}(...args)).then(done);`,
      ...args
    )) as T
  }

  /** Runs `fn(arg)` in the page; a returned promise is awaited. */
  async evaluate<T>(fn: string | ((arg: any) => unknown), arg?: unknown): Promise<T> {
    return this.runUserScript<T>(`const fn = (${fn.toString()}); return fn(arg);`, [arg])
  }

  /** Runs `fn(element, arg)` against the only element of `spec`. */
  async evaluateOn<T>(
    spec: LocatorSpec,
    fn: (el: any, arg: any) => unknown,
    arg?: unknown
  ): Promise<T> {
    return this.runUserScript<T>(
      `const els = window.__memryPw.queryAll(spec);
       if (els.length !== 1) throw new Error('locator matched ' + els.length + ' elements');
       return (${fn.toString()})(els[0], arg);`,
      [arg],
      spec
    )
  }

  async evaluateAllOn<T>(
    spec: LocatorSpec,
    fn: (els: any[], arg: any) => unknown,
    arg?: unknown
  ): Promise<T> {
    return this.runUserScript<T>(
      `return (${fn.toString()})(window.__memryPw.queryAll(spec), arg);`,
      [arg],
      spec
    )
  }

  private async runUserScript<T>(body: string, args: unknown[], spec?: LocatorSpec): Promise<T> {
    // `__name` is the helper a bundler adds to named functions; the page has no such helper.
    const script = `${INSTALL_SCRIPT}
      const __name = (target) => target;
      const [spec, arg, done] = arguments;
      Promise.resolve().then(() => { ${body} }).then(
        (value) => done({ ok: true, undef: value === undefined, value: value === undefined ? null : value }),
        (error) => done({ ok: false, error: String(error && error.stack || error) })
      );`
    const outcome = (await this.browser.executeAsync(script, spec ?? null, args[0] ?? null)) as {
      ok: boolean
      undef?: boolean
      value?: unknown
      error?: string
    }
    if (!outcome.ok) throw new HarnessError(`evaluate failed: ${outcome.error}`)
    return (outcome.undef ? undefined : outcome.value) as T
  }

  /** Polls the target state of a single element until it is actionable, as Playwright does. */
  async waitActionable(
    spec: LocatorSpec,
    describe: string,
    { enabled = true, force = false, scroll = true, timeout = this.timeoutMs } = {}
  ): Promise<TargetState> {
    const deadline = Date.now() + timeout
    let reason = 'not found'
    for (;;) {
      const state = await this.pwAsync<TargetState & { stable?: boolean }>('settle', spec, scroll)
      if (state.count > 1) {
        throw new HarnessError(
          `strict mode violation: ${describe} resolved to ${state.count} elements`
        )
      }
      if (state.count === 1 && state.box) {
        if (force) return state
        if (!state.visible) reason = 'not visible'
        else if (enabled && !state.enabled) reason = 'not enabled'
        else if (!state.hit) reason = 'covered by another element'
        else if (!state.stable) reason = 'not stable'
        else return state
      } else {
        reason = 'not found'
      }
      if (Date.now() >= deadline) {
        throw new HarnessError(
          `${describe}: waiting for the element timed out after ${timeout} ms (${reason})`
        )
      }
      await sleep(50)
    }
  }

  // ---- input ---------------------------------------------------------------------------------

  async keys(actions: KeyAction[]): Promise<void> {
    await this.browser.performActions([{ type: 'key', id: 'keyboard', actions }])
  }

  press(combo: string): Promise<void> {
    return this.keys(pressActions(combo))
  }

  typeText(text: string): Promise<void> {
    return this.keys(typeActions(text))
  }

  /**
   * One pointer sequence. Modifier keys are held for the whole sequence, each on its own key
   * source: they go down on the first tick and up on a final one, so every pointer action
   * happens with them held.
   */
  async pointer(actions: unknown[], modifiers: string[] = []): Promise<void> {
    const pause = { type: 'pause', duration: 0 }
    const sources: unknown[] = [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: modifiers.length > 0 ? [...actions, pause] : actions
      }
    ]
    modifiers.forEach((key, index) => {
      const [down] = pressActions(key)
      const up = pressActions(key).at(-1)
      sources.push({
        type: 'key',
        id: `modifier-${index}`,
        actions: [down, ...actions.slice(1).map(() => pause), up]
      })
    })
    await this.browser.performActions(sources)
  }

  async moveMouse(x: number, y: number): Promise<void> {
    this.mouseX = x
    this.mouseY = y
    await this.pw('watch')
    await this.pointer([
      { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }
    ])
    await this.pw('fixupHover', Math.round(x), Math.round(y))
  }

  async mouseDown(button: MouseButton): Promise<void> {
    await this.pointer([{ type: 'pointerDown', button: BUTTON_INDEX[button] }])
  }

  async mouseUp(button: MouseButton): Promise<void> {
    await this.pointer([{ type: 'pointerUp', button: BUTTON_INDEX[button] }])
  }

  async clickAt(
    x: number,
    y: number,
    { button = 'left', clickCount = 1, modifiers = [] as string[] } = {}
  ): Promise<void> {
    this.mouseX = x
    this.mouseY = y
    const index = BUTTON_INDEX[button as MouseButton]
    await this.pw('watch')
    const presses = Array.from({ length: clickCount }, () => [
      { type: 'pointerDown', button: index },
      { type: 'pointerUp', button: index }
    ]).flat()
    await this.pointer(
      [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }, ...presses],
      modifiers
    )
    await this.pw('fixup', Math.round(x), Math.round(y), index, clickCount)
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.browser.performActions([
      {
        type: 'wheel',
        id: 'wheel',
        actions: [
          {
            type: 'scroll',
            x: Math.round(this.mouseX),
            y: Math.round(this.mouseY),
            deltaX: Math.round(deltaX),
            deltaY: Math.round(deltaY),
            duration: 0,
            origin: 'viewport'
          }
        ]
      }
    ])
  }
}
