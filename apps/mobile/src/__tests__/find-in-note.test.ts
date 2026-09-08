// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findTextRanges, installFindInNote } from '../../editor-web/src/find-in-note'

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === name
  )
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return match
}

describe('find in note', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.replaceChildren()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds every case-insensitive rendered-text match without changing the DOM', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Memry keeps memory.</p><p>MEMRY stays calm.</p>'
    const before = root.innerHTML

    const ranges = findTextRanges(root, 'memry')

    expect(ranges.map((range) => range.toString())).toEqual(['Memry', 'MEMRY'])
    expect(root.innerHTML).toBe(before)
  })

  it('matches text split across inline formatting nodes', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>hello <strong>world</strong></p>'

    const ranges = findTextRanges(root, 'HELLO WORLD')

    expect(ranges.map((range) => range.toString())).toEqual(['hello world'])
  })

  it('does not match text across separate blocks', () => {
    const root = document.createElement('div')
    root.innerHTML = '<ul><li>foo</li><li>bar</li></ul>'

    expect(findTextRanges(root, 'foobar')).toEqual([])
  })

  it('keeps source offsets correct when lowercasing expands a character', () => {
    const root = document.createElement('div')
    root.textContent = 'İx'

    const ranges = findTextRanges(root, 'x')

    expect(ranges.map((range) => range.toString())).toEqual(['x'])
  })

  it('debounces live results and wraps previous and next navigation', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>note one note two</p>'
    const host = document.createElement('div')
    document.body.append(root, host)
    const states: { matchCount: number; currentIndex: number }[] = []
    const controller = installFindInNote(host, root, (state) => {
      states.push({ matchCount: state.matchCount, currentIndex: state.currentIndex })
    })

    controller.open()
    const input = document.querySelector<HTMLInputElement>('.editor-find-input')!
    input.value = 'NOTE'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(document.querySelector('.editor-find-count')?.textContent).toBe('')
    vi.advanceTimersByTime(150)
    expect(document.querySelector('.editor-find-count')?.textContent).toBe('1/2')

    button('Previous match').click()
    expect(document.querySelector('.editor-find-count')?.textContent).toBe('2/2')
    button('Next match').click()
    expect(document.querySelector('.editor-find-count')?.textContent).toBe('1/2')
    expect(states.at(-1)).toEqual({ matchCount: 2, currentIndex: 0 })
    controller.destroy()
  })

  it('reruns an open query after editor mutations and cleans up on Done', () => {
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

    root.append(document.createTextNode(' one'))
    return Promise.resolve().then(() => {
      vi.advanceTimersByTime(300)
      expect(document.querySelector('.editor-find-count')?.textContent).toBe('1/2')

      button('Done').click()
      expect(host.hidden).toBe(true)
      expect(host.childElementCount).toBe(0)
      controller.destroy()
    })
  })
})
