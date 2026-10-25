import { writeFileSync } from 'node:fs'

import { HarnessError } from '../errors'
import { sleep } from '../wait'
import { type MouseButton, type PageCore } from './driver'
import {
  type ByRoleOptions,
  type LocatorSpec,
  type TextOptions,
  describeSpec,
  specs
} from './selector-spec'

export interface ClickOptions {
  button?: MouseButton
  clickCount?: number
  modifiers?: string[]
  position?: { x: number; y: number }
  force?: boolean
  timeout?: number
}

export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

interface Inspected<T> {
  count: number
  value?: T
}

/** A Playwright-shaped locator over the in-page resolver. A locator holds no element. */
export class Locator {
  constructor(
    readonly core: PageCore,
    readonly spec: LocatorSpec
  ) {}

  toString(): string {
    return describeSpec(this.spec)
  }

  private derive(next: LocatorSpec): Locator {
    return new Locator(this.core, next)
  }

  // ---- composition ---------------------------------------------------------------------------

  locator(selector: string): Locator {
    return this.derive(specs.css(this.spec, selector))
  }
  getByRole(role: string, options?: ByRoleOptions): Locator {
    return this.derive(specs.role(this.spec, role, options))
  }
  getByTestId(id: string): Locator {
    return this.derive(specs.testId(this.spec, id))
  }
  getByText(text: string | RegExp, options?: TextOptions): Locator {
    return this.derive(specs.text(this.spec, text, options))
  }
  getByLabel(text: string | RegExp, options?: TextOptions): Locator {
    return this.derive(specs.label(this.spec, text, options))
  }
  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator {
    return this.derive(specs.placeholder(this.spec, text, options))
  }
  filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp }): Locator {
    return this.derive(specs.filter(this.spec, options))
  }
  first(): Locator {
    return this.nth(0)
  }
  last(): Locator {
    return this.nth(-1)
  }
  nth(index: number): Locator {
    return this.derive(specs.nth(this.spec, index))
  }

  // ---- immediate state -----------------------------------------------------------------------

  inspect<T>(kind: string, arg?: string): Promise<Inspected<T>> {
    return this.core.pw<Inspected<T>>('inspect', this.spec, kind, arg ?? null)
  }

  async count(): Promise<number> {
    return (await this.inspect('count')).count
  }

  /** Reads one value now; no waiting. A locator that matches several elements is a strict error. */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T types the value the caller asked the page for
  private async read<T>(kind: string, arg?: string): Promise<{ present: boolean; value?: T }> {
    const { count, value } = await this.inspect<T>(kind, arg)
    if (count > 1) {
      throw new HarnessError(`strict mode violation: ${this} resolved to ${count} elements`)
    }
    return { present: count === 1, value }
  }

  async isVisible(): Promise<boolean> {
    return (await this.read<boolean>('visible')).value === true
  }
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible())
  }
  async isEnabled(): Promise<boolean> {
    return (await this.readWaiting<boolean>('enabled')) === true
  }
  async isDisabled(): Promise<boolean> {
    return !(await this.isEnabled())
  }
  async isChecked(): Promise<boolean> {
    return (await this.readWaiting<boolean>('checked')) === true
  }
  async isEditable(): Promise<boolean> {
    return (await this.readWaiting<boolean>('editable')) === true
  }

  // ---- reads that wait for the element -------------------------------------------------------

  /** Polls until the element exists, then returns the value. */
  async readWaiting<T>(
    kind: string,
    arg?: string,
    timeout = this.core.timeoutMs
  ): Promise<T | undefined> {
    const deadline = Date.now() + timeout
    for (;;) {
      const { present, value } = await this.read<T>(kind, arg)
      if (present) return value
      if (Date.now() >= deadline) {
        throw new HarnessError(`${this}: waiting for the element timed out after ${timeout} ms`)
      }
      await sleep(50)
    }
  }

  async textContent(): Promise<string | null> {
    return (await this.readWaiting<string>('text')) ?? null
  }
  async innerText(): Promise<string> {
    return (await this.readWaiting<string>('innerText')) ?? ''
  }
  async inputValue(): Promise<string> {
    return (await this.readWaiting<string>('value')) ?? ''
  }
  async getAttribute(name: string): Promise<string | null> {
    return (await this.readWaiting<string | null>('attr', name)) ?? null
  }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const box = await this.readWaiting<{ x: number; y: number; width: number; height: number }>(
      'box'
    )
    return box && box.width > 0 && box.height > 0 ? box : null
  }
  async allTextContents(): Promise<string[]> {
    return ((await this.inspect<string[]>('texts')).value ?? []).map((text) => text ?? '')
  }

  evaluate<T>(fn: (el: any, arg: any) => T | Promise<T>, arg?: unknown): Promise<T> {
    return this.core.evaluateOn<T>(this.spec, fn, arg)
  }
  evaluateAll<T>(fn: (els: any[], arg: any) => T | Promise<T>, arg?: unknown): Promise<T> {
    return this.core.evaluateAllOn<T>(this.spec, fn, arg)
  }

  // ---- waiting -------------------------------------------------------------------------------

  async waitFor({
    state = 'visible',
    timeout = this.core.timeoutMs
  }: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + timeout
    for (;;) {
      const { count, value } = await this.inspect<boolean>('visible')
      const done =
        (state === 'attached' && count > 0) ||
        (state === 'detached' && count === 0) ||
        (state === 'visible' && count === 1 && value === true) ||
        (state === 'hidden' && (count === 0 || (count === 1 && value === false)))
      if (done) return
      if (Date.now() >= deadline) {
        throw new HarnessError(
          `${this}: waiting for state "${state}" timed out after ${timeout} ms`
        )
      }
      await sleep(50)
    }
  }

  // ---- actions -------------------------------------------------------------------------------

  private actionable(options: { enabled?: boolean; force?: boolean; timeout?: number } = {}) {
    return this.core.waitActionable(this.spec, String(this), options)
  }

  async click(options: ClickOptions = {}): Promise<void> {
    const state = await this.actionable({ force: options.force, timeout: options.timeout })
    const box = state.box!
    const x = options.position ? box.x + options.position.x : state.x!
    const y = options.position ? box.y + options.position.y : state.y!
    await this.core.clickAt(x, y, {
      button: options.button,
      clickCount: options.clickCount,
      modifiers: options.modifiers
    })
  }

  dblclick(options: ClickOptions = {}): Promise<void> {
    return this.click({ ...options, clickCount: 2 })
  }

  async hover(options: { timeout?: number; force?: boolean } = {}): Promise<void> {
    const state = await this.actionable(options)
    await this.core.moveMouse(state.x!, state.y!)
  }

  async fill(text: string, options: { timeout?: number } = {}): Promise<void> {
    await this.actionable(options)
    const result = await this.core.pw<{ done?: boolean; error?: string }>('fill', this.spec, text)
    if (!result.done)
      throw new HarnessError(`${this}: fill failed: ${result.error ?? 'element changed'}`)
  }

  async clear(): Promise<void> {
    await this.fill('')
  }

  async focus(): Promise<void> {
    await this.readWaiting<boolean>('visible')
    await this.core.pw('focus', this.spec)
  }

  async blur(): Promise<void> {
    await this.readWaiting<boolean>('visible')
    await this.core.pw('blur', this.spec)
  }

  async press(combo: string, options: { timeout?: number } = {}): Promise<void> {
    await this.actionable({ ...options, enabled: false })
    await this.core.pw('focus', this.spec)
    await this.core.press(combo)
  }

  async type(text: string, options: { timeout?: number } = {}): Promise<void> {
    await this.actionable({ ...options, enabled: false })
    await this.core.pw('focus', this.spec)
    await this.core.typeText(text)
  }

  pressSequentially(text: string): Promise<void> {
    return this.type(text)
  }

  async check(options: ClickOptions = {}): Promise<void> {
    await this.setChecked(true, options)
  }

  async uncheck(options: ClickOptions = {}): Promise<void> {
    await this.setChecked(false, options)
  }

  private async setChecked(checked: boolean, options: ClickOptions): Promise<void> {
    if ((await this.isChecked()) === checked) return
    await this.click(options)
    if ((await this.isChecked()) !== checked) {
      throw new HarnessError(`${this}: clicking did not set checked to ${checked}`)
    }
  }

  /** Presses on this element, moves over `target` in steps and releases there. */
  async dragTo(target: Locator): Promise<void> {
    const from = await this.actionable()
    const to = await target.core.waitActionable(target.spec, String(target), { enabled: false })
    await this.core.moveMouse(from.x!, from.y!)
    await this.core.mouseDown('left')
    const steps = 6
    for (let step = 1; step <= steps; step += 1) {
      await this.core.moveMouse(
        from.x! + ((to.x! - from.x!) * step) / steps,
        from.y! + ((to.y! - from.y!) * step) / steps
      )
    }
    await this.core.mouseUp('left')
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.readWaiting<boolean>('visible')
    await this.core.pw('scrollIntoView', this.spec)
  }

  async screenshot(options: { path?: string } = {}): Promise<Buffer> {
    const png = Buffer.from(await this.core.browser.takeScreenshot(), 'base64')
    if (options.path) writeFileSync(options.path, png)
    return png
  }
}
