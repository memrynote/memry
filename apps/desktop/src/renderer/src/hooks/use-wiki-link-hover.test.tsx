import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMockApi } from '@tests/utils/render'
import { useWikiLinkHover } from './use-wiki-link-hover'

function setupLink(target = 'Daily Note') {
  const container = document.createElement('div')
  const link = document.createElement('span')
  link.setAttribute('data-wiki-link', 'true')
  link.setAttribute('data-target', target)
  link.getBoundingClientRect = vi.fn(() => ({
    top: 40,
    bottom: 60,
    left: 20,
    right: 100,
    width: 80,
    height: 20,
    x: 20,
    y: 40,
    toJSON: () => ({})
  }))
  container.appendChild(link)
  document.body.appendChild(container)
  return { container, link }
}

describe('useWikiLinkHover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    const api = getMockApi() as {
      notes: {
        previewByTitle: ReturnType<typeof vi.fn>
      }
    }
    api.notes.previewByTitle.mockResolvedValue({
      id: 'note-1',
      title: 'Daily Note',
      path: 'notes/Daily Note.md',
      excerpt: 'Preview'
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('shows a delayed preview for wiki links and dismisses on mouseout', async () => {
    const { container, link } = setupLink()
    const ref = { current: container }
    const { result } = renderHook(() => useWikiLinkHover(ref))

    act(() => {
      link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(result.current.isVisible).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.preview).toEqual(
      expect.objectContaining({ id: 'note-1', title: 'Daily Note' })
    )
    expect(result.current.position).toEqual({ top: 64, left: 20, placement: 'below' })
    expect(result.current.isVisible).toBe(true)

    act(() => {
      link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.isVisible).toBe(false)
  })

  it('keeps the preview open while the card is hovered, then dismisses after leave', async () => {
    const { container, link } = setupLink()
    const ref = { current: container }
    const { result } = renderHook(() => useWikiLinkHover(ref))

    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    act(() => result.current.handleCardMouseEnter())
    act(() => link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.isVisible).toBe(true)

    act(() => result.current.handleCardMouseLeave())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.isVisible).toBe(false)
  })

  it('uses cached previews and places the card above when there is not enough space below', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 100, configurable: true })
    const api = getMockApi() as {
      notes: {
        previewByTitle: ReturnType<typeof vi.fn>
      }
    }
    const { container, link } = setupLink('Cached')
    const ref = { current: container }
    const { result } = renderHook(() => useWikiLinkHover(ref))

    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.position?.placement).toBe('above')
    expect(api.notes.previewByTitle).toHaveBeenCalledTimes(1)

    act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(result.current.isVisible).toBe(false)

    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(api.notes.previewByTitle).toHaveBeenCalledTimes(1)
    expect(result.current.isVisible).toBe(true)
  })

  it('re-renders nothing when a scroll arrives with no preview open', () => {
    const { container } = setupLink()
    const ref = { current: container }
    let renders = 0
    renderHook(() => {
      renders++
      return useWikiLinkHover(ref)
    })

    const baseline = renders
    // One act() per event so React cannot batch them into a single render.
    for (let i = 0; i < 5; i++) {
      act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    }

    expect(renders).toBe(baseline)
  })

  it('hides an open preview on scroll, then stops re-rendering', async () => {
    const { container, link } = setupLink()
    const ref = { current: container }
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useWikiLinkHover(ref)
    })

    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.isVisible).toBe(true)

    act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(result.current.isVisible).toBe(false)

    // One more scroll to absorb React's render-phase bailout: right after a real
    // update it re-renders this component once before it can compare eagerly.
    act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    const settled = renders

    for (let i = 0; i < 5; i++) {
      act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    }

    expect(renders).toBe(settled)
    expect(result.current.isVisible).toBe(false)
  })

  it('cancels an armed preview on scroll so no card pops up over scrolled content', async () => {
    const api = getMockApi() as {
      notes: {
        previewByTitle: ReturnType<typeof vi.fn>
      }
    }
    const { container, link } = setupLink()
    const ref = { current: container }
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useWikiLinkHover(ref)
    })

    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    const baseline = renders
    act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(api.notes.previewByTitle).not.toHaveBeenCalled()
    expect(result.current.isVisible).toBe(false)
    expect(renders).toBe(baseline)
  })

  it('ignores missing targets, null previews, stale async results, and service failures', async () => {
    const api = getMockApi() as {
      notes: {
        previewByTitle: ReturnType<typeof vi.fn>
      }
    }
    const { container, link } = setupLink('')
    const ref = { current: container }
    const { result } = renderHook(() => useWikiLinkHover(ref))

    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(api.notes.previewByTitle).not.toHaveBeenCalled()

    link.setAttribute('data-target', 'Missing')
    api.notes.previewByTitle.mockResolvedValueOnce(null)
    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.isVisible).toBe(false)

    link.setAttribute('data-target', 'Broken')
    api.notes.previewByTitle.mockRejectedValueOnce(new Error('ipc failed'))
    act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.isVisible).toBe(false)
  })
})
