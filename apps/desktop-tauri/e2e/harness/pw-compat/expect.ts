import { isDeepStrictEqual } from 'node:util'

import { EXPECT_TIMEOUT_MS } from '../budgets'
import { HarnessError } from '../errors'
import { sleep } from '../wait'
import { Locator } from './locator'

const POLL_MS = 100

interface PollOptions {
  timeout?: number
  /** Delays between polls in ms; the last one repeats. Default 100. */
  intervals?: number[]
}

/**
 * Polls `probe` every 100 ms until `pass` accepts what it read, or fails with the last
 * reading. `negate` flips the condition: the poll ends when `pass` rejects.
 */
async function poll<T>(
  label: string,
  probe: () => Promise<T>,
  pass: (value: T) => boolean,
  negate: boolean,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const value = await probe()
      last = value
      if (pass(value) !== negate) return
    } catch (error) {
      if (!(error instanceof HarnessError) || /strict mode/.test(error.message)) throw error
      last = error.message
    }
    if (Date.now() >= deadline) {
      throw new HarnessError(
        `expect(${label})${negate ? '.not' : ''} did not hold within ${timeout} ms; last value: ${JSON.stringify(last)}`
      )
    }
    await sleep(POLL_MS)
  }
}

const matchesText = (actual: string, expected: string | RegExp, substring: boolean): boolean => {
  const normalized = actual.replace(/\s+/g, ' ').trim()
  if (expected instanceof RegExp) return expected.test(actual) || expected.test(normalized)
  const wanted = expected.replace(/\s+/g, ' ').trim()
  return substring ? normalized.includes(wanted) : normalized === wanted
}

export class LocatorExpect {
  constructor(
    private readonly locator: Locator,
    private readonly negate: boolean,
    private readonly timeout: number
  ) {}

  get not(): LocatorExpect {
    return new LocatorExpect(this.locator, !this.negate, this.timeout)
  }

  private opts: PollOptions = {}

  private check<T>(label: string, probe: () => Promise<T>, pass: (value: T) => boolean) {
    return poll(
      `${this.locator}).${label}`,
      probe,
      pass,
      this.negate,
      this.opts.timeout ?? this.timeout
    )
  }

  /** Per-call budget, as Playwright's `{ timeout }` option. */
  private with(options: PollOptions | undefined): this {
    this.opts = options ?? {}
    return this
  }

  /** Reads `kind` of the only element; a missing element reads as `undefined`. */
  private async value<T>(kind: string, arg?: string): Promise<T | undefined> {
    const { count, value } = await this.locator.inspect<T>(kind, arg)
    if (count > 1) {
      throw new HarnessError(`strict mode violation: ${this.locator} resolved to ${count} elements`)
    }
    return count === 1 ? value : undefined
  }

  toBeVisible(options?: PollOptions): Promise<void> {
    return this.with(options).check(
      'toBeVisible',
      () => this.value<boolean>('visible'),
      (v) => v === true
    )
  }
  toBeHidden(options?: PollOptions): Promise<void> {
    return this.with(options).check(
      'toBeHidden',
      () => this.value<boolean>('visible'),
      (v) => v !== true
    )
  }
  toBeEnabled(options?: PollOptions): Promise<void> {
    return this.with(options).check(
      'toBeEnabled',
      () => this.value<boolean>('enabled'),
      (v) => v === true
    )
  }
  toBeDisabled(options?: PollOptions): Promise<void> {
    return this.with(options).check(
      'toBeDisabled',
      () => this.value<boolean>('enabled'),
      (v) => v === false
    )
  }
  toBeChecked(options?: PollOptions): Promise<void> {
    return this.with(options).check(
      'toBeChecked',
      () => this.value<boolean>('checked'),
      (v) => v === true
    )
  }
  toBeFocused(options?: PollOptions): Promise<void> {
    return this.with(options).check(
      'toBeFocused',
      () => this.value<boolean>('focused'),
      (v) => v === true
    )
  }
  toHaveText(expected: string | RegExp, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toHaveText(${String(expected)})`,
      () => this.value<string>('text'),
      (v) => v !== undefined && matchesText(v, expected, false)
    )
  }
  toContainText(expected: string | RegExp, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toContainText(${String(expected)})`,
      () => this.value<string>('text'),
      (v) => v !== undefined && matchesText(v, expected, true)
    )
  }
  toHaveValue(expected: string | RegExp, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toHaveValue(${String(expected)})`,
      () => this.value<string>('value'),
      (v) => v !== undefined && (expected instanceof RegExp ? expected.test(v) : v === expected)
    )
  }
  toHaveCount(expected: number, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toHaveCount(${expected})`,
      () => this.locator.count(),
      (v) => v === expected
    )
  }
  toHaveAttribute(name: string, expected?: string | RegExp, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toHaveAttribute(${name})`,
      () => this.value<string | null>('attr', name),
      (v) =>
        expected === undefined
          ? v !== undefined && v !== null
          : typeof v === 'string' &&
            (expected instanceof RegExp ? expected.test(v) : v === expected)
    )
  }
  toHaveClass(expected: string | RegExp, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toHaveClass(${String(expected)})`,
      () => this.value<string>('class'),
      (v) =>
        v !== undefined &&
        (expected instanceof RegExp
          ? expected.test(v)
          : v.split(/\s+/).filter(Boolean).join(' ') === expected.trim())
    )
  }
  toHaveCSS(property: string, expected: string | RegExp, options?: PollOptions): Promise<void> {
    return this.with(options).check(
      `toHaveCSS(${property})`,
      () => this.value<string>('css', property),
      (v) => v !== undefined && (expected instanceof RegExp ? expected.test(v) : v === expected)
    )
  }
}

/** `toMatchObject` semantics: every key of `expected` matches, recursively; arrays match by index. */
function isSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected)
  if (actual === null || typeof actual !== 'object') return false
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => isSubset(actual[index], item))
    )
  }
  return Object.entries(expected).every(([key, value]) =>
    isSubset((actual as Record<string, unknown>)[key], value)
  )
}

export class ValueExpect {
  constructor(
    private readonly actual: unknown,
    private readonly negate: boolean
  ) {}

  get not(): ValueExpect {
    return new ValueExpect(this.actual, !this.negate)
  }

  private assert(label: string, ok: boolean, expected?: unknown): void {
    if (ok === this.negate) {
      throw new HarnessError(
        `expect(${JSON.stringify(this.actual)})${this.negate ? '.not' : ''}.${label}${
          expected === undefined ? '' : `(${JSON.stringify(expected)})`
        } failed`
      )
    }
  }

  toBe(expected: unknown): void {
    this.assert('toBe', Object.is(this.actual, expected), expected)
  }
  toEqual(expected: unknown): void {
    this.assert('toEqual', isDeepStrictEqual(this.actual, expected), expected)
  }
  toMatchObject(expected: unknown): void {
    this.assert('toMatchObject', isSubset(this.actual, expected), expected)
  }
  toBeNull(): void {
    this.assert('toBeNull', this.actual === null)
  }
  toBeUndefined(): void {
    this.assert('toBeUndefined', this.actual === undefined)
  }
  toBeDefined(): void {
    this.assert('toBeDefined', this.actual !== undefined)
  }
  toBeTruthy(): void {
    this.assert('toBeTruthy', !!this.actual)
  }
  toBeFalsy(): void {
    this.assert('toBeFalsy', !this.actual)
  }
  toContain(expected: unknown): void {
    const actual = this.actual as string | unknown[]
    this.assert('toContain', actual.includes(expected as never), expected)
  }
  toBeGreaterThan(expected: number): void {
    this.assert('toBeGreaterThan', (this.actual as number) > expected, expected)
  }
  toBeGreaterThanOrEqual(expected: number): void {
    this.assert('toBeGreaterThanOrEqual', (this.actual as number) >= expected, expected)
  }
  toBeLessThan(expected: number): void {
    this.assert('toBeLessThan', (this.actual as number) < expected, expected)
  }
  toBeLessThanOrEqual(expected: number): void {
    this.assert('toBeLessThanOrEqual', (this.actual as number) <= expected, expected)
  }
  toMatch(expected: string | RegExp): void {
    const actual = String(this.actual)
    this.assert(
      'toMatch',
      expected instanceof RegExp ? expected.test(actual) : actual.includes(expected),
      expected
    )
  }
  toHaveLength(expected: number): void {
    this.assert('toHaveLength', (this.actual as { length: number }).length === expected, expected)
  }
}

/** `expect.poll(fn).toBe(...)`: re-reads `fn` every 100 ms until the matcher holds. */
export class PollExpect {
  constructor(
    private readonly read: () => unknown,
    private readonly negate: boolean,
    private readonly timeout: number,
    private readonly intervals: number[] = [POLL_MS]
  ) {}

  get not(): PollExpect {
    return new PollExpect(this.read, !this.negate, this.timeout, this.intervals)
  }

  private async until(run: (matchers: ValueExpect) => void): Promise<void> {
    const deadline = Date.now() + this.timeout
    for (let attempt = 0; ; attempt += 1) {
      const actual = await this.read()
      try {
        run(new ValueExpect(actual, this.negate))
        return
      } catch (error) {
        if (Date.now() >= deadline) throw error
      }
      await sleep(this.intervals[Math.min(attempt, this.intervals.length - 1)])
    }
  }

  toBe(expected: unknown): Promise<void> {
    return this.until((m) => m.toBe(expected))
  }
  toEqual(expected: unknown): Promise<void> {
    return this.until((m) => m.toEqual(expected))
  }
  toMatchObject(expected: unknown): Promise<void> {
    return this.until((m) => m.toMatchObject(expected))
  }
  toBeNull(): Promise<void> {
    return this.until((m) => m.toBeNull())
  }
  toBeTruthy(): Promise<void> {
    return this.until((m) => m.toBeTruthy())
  }
  toBeGreaterThan(expected: number): Promise<void> {
    return this.until((m) => m.toBeGreaterThan(expected))
  }
  toContain(expected: unknown): Promise<void> {
    return this.until((m) => m.toContain(expected))
  }
  toMatch(expected: string | RegExp): Promise<void> {
    return this.until((m) => m.toMatch(expected))
  }
  toHaveLength(expected: number): Promise<void> {
    return this.until((m) => m.toHaveLength(expected))
  }
}

export interface Expect {
  (actual: Locator): LocatorExpect
  (actual: unknown): ValueExpect
  poll(read: () => unknown, options?: PollOptions): PollExpect
}

/** Mutable so a spec can lower the `expect` budget, as Playwright's `expect.configure`. */
const budget = { timeout: EXPECT_TIMEOUT_MS }

export const expect = ((actual: unknown) =>
  actual instanceof Locator
    ? new LocatorExpect(actual, false, budget.timeout)
    : new ValueExpect(actual, false)) as Expect

expect.poll = (read, options = {}) =>
  new PollExpect(
    read,
    false,
    options.timeout ?? budget.timeout,
    options.intervals?.length ? options.intervals : [POLL_MS]
  )
