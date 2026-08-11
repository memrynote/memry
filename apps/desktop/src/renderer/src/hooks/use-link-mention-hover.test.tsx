import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLinkMentionHover } from './use-link-mention-hover'

const api = window.api as unknown as {
  inbox: { previewLink: ReturnType<typeof vi.fn> }
}

/**
 * Build the real link-mention DOM: an <a data-link-mention> wrapping a favicon
 * <img> and site/title <span>s. The child nodes are the crux of the hover bug —
 * mouseover/mouseout bubble, so sweeping across them fires spurious mouseout
 * events on internal boundaries.
 */
function setupMention(url: string) {
  const container = document.createElement('div')
  const link = document.createElement('a')
  link.setAttribute('data-link-mention', '')
  link.setAttribute('data-url', url)
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

  const favicon = document.createElement('img')
  favicon.className = 'link-mention-favicon'
  const site = document.createElement('span')
  site.className = 'link-mention-site'
  const title = document.createElement('span')
  title.className = 'link-mention-title'
  link.append(favicon, site, title)

  container.appendChild(link)
  document.body.appendChild(container)
  return { container, link, favicon, site, title }
}

describe('useLinkMentionHover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    api.inbox.previewLink.mockReset()
    api.inbox.previewLink.mockResolvedValue({ title: 'Example', domain: 'example.com' })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('shows a delayed preview when hovering a mention child node', async () => {
    const { container, favicon } = setupMention('https://example.com/a')
    const ref = { current: container }
    const { result } = renderHook(() => useLinkMentionHover(ref))

    act(() => {
      favicon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(result.current.isVisible).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.preview).toEqual(expect.objectContaining({ title: 'Example' }))
    expect(result.current.position).toEqual({ top: 64, left: 20, placement: 'below' })
    expect(result.current.isVisible).toBe(true)
  })

  it('keeps the preview armed when the cursor moves between the mentions own children', async () => {
    const { container, favicon, title } = setupMention('https://example.com/b')
    const ref = { current: container }
    const { result } = renderHook(() => useLinkMentionHover(ref))

    // Enter on the favicon, then sweep to the title before the 300ms delay —
    // the natural reading motion. mouseout(img -> title) and mouseover(title)
    // are internal boundary crossings and must NOT cancel the pending preview.
    act(() => {
      favicon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    act(() => {
      favicon.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: title }))
      title.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: favicon }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.isVisible).toBe(true)
  })

  it('re-renders nothing when a scroll arrives with no preview open', () => {
    const { container } = setupMention('https://example.com/quiet')
    const ref = { current: container }
    let renders = 0
    renderHook(() => {
      renders++
      return useLinkMentionHover(ref)
    })

    const baseline = renders
    // One act() per event so React cannot batch them into a single render.
    for (let i = 0; i < 5; i++) {
      act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    }

    expect(renders).toBe(baseline)
  })

  it('hides an open preview on scroll, then stops re-rendering', async () => {
    const { container, favicon } = setupMention('https://example.com/open')
    const ref = { current: container }
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useLinkMentionHover(ref)
    })

    act(() => favicon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
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
    const { container, favicon } = setupMention('https://example.com/armed')
    const ref = { current: container }
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useLinkMentionHover(ref)
    })

    act(() => favicon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    const baseline = renders
    act(() => container.dispatchEvent(new Event('scroll', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(api.inbox.previewLink).not.toHaveBeenCalled()
    expect(result.current.isVisible).toBe(false)
    expect(renders).toBe(baseline)
  })

  it('dismisses when the cursor leaves the mention entirely', async () => {
    const { container, link, favicon } = setupMention('https://example.com/c')
    const ref = { current: container }
    const { result } = renderHook(() => useLinkMentionHover(ref))

    act(() => favicon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.isVisible).toBe(true)

    act(() =>
      link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.isVisible).toBe(false)
  })
})
