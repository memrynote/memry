// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installFindInNote } from '../../editor-web/src/find-in-note'
import { isReducedMotion, scrollBehavior } from '../../editor-web/src/reduced-motion'

/**
 * RTL and reduced motion in the guest (#2114).
 *
 * The host now feeds `I18nManager.isRTL` and the live `AccessibilityInfo`
 * value into `cfg`, which only means anything if the guest's own stylesheet
 * flips on `dir` and its scripts stop animating when the class is on. Two of
 * these are source guards: a physical `margin-left` or a literal
 * `behavior: 'smooth'` is invisible at runtime in jsdom but breaks a real RTL
 * or reduce-motion reader.
 */
const here = dirname(fileURLToPath(import.meta.url))

const guestSource = (name: string): string =>
  readFileSync(join(here, '..', '..', 'editor-web', 'src', name), 'utf8')

describe('guest reduced motion', () => {
  afterEach(() => {
    document.documentElement.classList.remove('reduced-motion')
  })

  it('reads the flag off the class main.ts writes from cfg', () => {
    expect(isReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')

    document.documentElement.classList.add('reduced-motion')

    expect(isReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')
  })
})

describe('find-in-note scrolling', () => {
  const rect = (top: number, bottom: number): DOMRect =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect
  let scrollBy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.replaceChildren()
    // jsdom's `Range` has no layout at all, so nothing would ever scroll. A
    // match above the viewport is the case that scrolls.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      value: () => rect(-200, -180),
      configurable: true
    })
    scrollBy = vi.fn()
    Object.defineProperty(window, 'scrollBy', { value: scrollBy, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    document.documentElement.classList.remove('reduced-motion')
  })

  const search = (): void => {
    const root = document.createElement('div')
    root.textContent = 'one'
    const host = document.createElement('div')
    document.body.append(root, host)
    const controller = installFindInNote(host, root)
    controller.open()
    const input = document.querySelector<HTMLInputElement>('.editor-find-input')!
    input.value = 'one'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    vi.advanceTimersByTime(150)
    controller.destroy()
  }

  it('scrolls smoothly by default', () => {
    search()

    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
  })

  it('jumps instead of animating when reduced motion is on', () => {
    document.documentElement.classList.add('reduced-motion')

    search()

    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
  })
})

describe('guest stylesheet', () => {
  const css = guestSource('styles.css')

  it('uses logical properties only, so dir=rtl flips the whole document', () => {
    const physical =
      /(^|[\s;{])(margin|padding|border)-(left|right)\b|(^|[\s;{])(left|right)\s*:|border-(top|bottom)-(left|right)-radius|text-align\s*:\s*(left|right)|float\s*:\s*(left|right)/gm
    const offenders = css.split('\n').flatMap((line, index) => {
      physical.lastIndex = 0
      return physical.test(line) ? [`${index + 1}: ${line.trim()}`] : []
    })

    expect(offenders).toEqual([])
  })

  it('neutralises motion on the root element as well as inside it', () => {
    // `html` carries the class AND is the scroller, so a `.reduced-motion *`
    // selector on its own would leave `scroll-behavior` untouched.
    expect(css).toMatch(/\.reduced-motion,\s*\n\s*\.reduced-motion \*/)
    const block = css.slice(css.indexOf('.reduced-motion,'))
    const rules = block.slice(0, block.indexOf('}'))
    expect(rules).toContain('animation-duration: 0.001ms !important')
    expect(rules).toContain('transition-duration: 0.001ms !important')
    expect(rules).toContain('scroll-behavior: auto !important')
  })
})

describe('guest scripts', () => {
  it('never hardcode a smooth scroll the stylesheet cannot reach', () => {
    const scripts = ['find-in-note.ts', 'main.ts', 'editor-toolbar.ts', 'blocks.ts', 'inline.ts']

    for (const name of scripts) {
      expect(guestSource(name), name).not.toMatch(/behavior:\s*'smooth'/)
    }
  })
})

describe('host cfg', () => {
  const screen = readFileSync(
    join(here, '..', 'app', '(vault)', '(tabs)', 'notes', '[id].tsx'),
    'utf8'
  )

  it('feeds the real device values instead of hardcoded falses', () => {
    expect(screen).not.toMatch(/rtl:\s*false/)
    expect(screen).not.toMatch(/reducedMotion:\s*false/)
    expect(screen).toContain('rtl: I18nManager.isRTL')
    expect(screen).toContain('reducedMotion,')
    expect(screen).toContain('useReducedMotion()')
  })
})
