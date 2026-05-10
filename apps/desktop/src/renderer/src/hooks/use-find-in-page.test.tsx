import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFindInPage } from './use-find-in-page'

describe('useFindInPage', () => {
  let container: HTMLDivElement
  let ref: { current: HTMLElement | null }
  let highlights: Map<string, unknown>

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    container.innerHTML = '<p>Alpha beta alpha</p><p>Beta</p>'
    document.body.append(container)
    ref = { current: container }
    highlights = new Map()

    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        highlights: {
          set: vi.fn((key: string, value: unknown) => highlights.set(key, value)),
          delete: vi.fn((key: string) => highlights.delete(key))
        }
      }
    })
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: vi.fn(function MockHighlight(...ranges: Range[]) {
        return { ranges }
      })
    })
    Element.prototype.scrollIntoView = vi.fn()
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens, searches text ranges, navigates matches, and closes cleanly', () => {
    const { result, unmount } = renderHook(() => useFindInPage(ref))
    const input = document.createElement('input')
    result.current.inputRef.current = input
    vi.spyOn(input, 'focus')
    vi.spyOn(input, 'select')

    act(() => result.current.open())
    expect(result.current.isOpen).toBe(true)
    expect(input.focus).toHaveBeenCalled()
    expect(input.select).toHaveBeenCalled()

    act(() => result.current.setQuery('alpha'))
    expect(result.current.query).toBe('alpha')
    expect(result.current.matchCount).toBe(2)
    expect(result.current.currentIndex).toBe(0)
    expect(CSS.highlights.set).toHaveBeenCalledWith('find-matches', expect.anything())

    act(() => result.current.next())
    expect(result.current.currentIndex).toBe(1)
    act(() => result.current.next())
    expect(result.current.currentIndex).toBe(0)
    act(() => result.current.prev())
    expect(result.current.currentIndex).toBe(1)

    act(() => result.current.setQuery('missing'))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.currentIndex).toBe(-1)

    act(() => result.current.close())
    expect(result.current.isOpen).toBe(false)
    expect(result.current.query).toBe('')
    expect(result.current.matchCount).toBe(0)

    unmount()
    expect(CSS.highlights.delete).toHaveBeenCalledWith('find-matches')
  })

  it('handles keyboard shortcut, disabled mode, DOM mutations, and missing containers', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
    const { result, rerender } = renderHook(({ enabled }) => useFindInPage(ref, enabled), {
      initialProps: { enabled: true }
    })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))
    })
    expect(result.current.isOpen).toBe(true)

    act(() => result.current.setQuery('beta'))
    expect(result.current.matchCount).toBe(2)

    await act(async () => {
      container.append(document.createTextNode(' beta'))
      await Promise.resolve()
      vi.advanceTimersByTime(300)
    })
    expect(result.current.matchCount).toBe(3)

    act(() => result.current.close())
    rerender({ enabled: false })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))
    })
    expect(result.current.isOpen).toBe(false)

    ref.current = null
    rerender({ enabled: true })
    act(() => {
      result.current.open()
      result.current.setQuery('alpha')
    })
    expect(result.current.matchCount).toBe(0)
  })
})
