import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MorphLine } from './fold-morph-line'
import type { MorphToken } from './fold-morph'

const words = (text: string): MorphToken[] =>
  text.split(/(\s+)/).map((part, i) => ({ text: part, src: /^\s+$/.test(part) ? null : i }))

function stubAnimate(impl: () => unknown): void {
  ;(Element.prototype as { animate?: unknown }).animate = impl
}

describe('MorphLine', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (Element.prototype as { animate?: unknown }).animate
  })

  it('swaps instantly and leaves one layer when the browser cannot animate', () => {
    const { rerender, container } = render(
      <MorphLine level="brief" tokens={words('one two three')}>
        one two three
      </MorphLine>
    )
    rerender(
      <MorphLine level="takeaway" tokens={words('one three')}>
        one three
      </MorphLine>
    )
    expect(container).toHaveTextContent('one three')
    expect(container.querySelector('[data-morph]')).toBeNull()
  })

  it('crossfades when nothing is laid out, then drops the outgoing layer', async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }))
    stubAnimate(animate)
    const { rerender, container } = render(
      <MorphLine level="brief" tokens={words('one two three')}>
        one two three
      </MorphLine>
    )
    await act(async () => {
      rerender(
        <MorphLine level="takeaway" tokens={words('one three')}>
          one three
        </MorphLine>
      )
    })
    // jsdom measures every box as zero, so the word slide falls back to layers fading.
    expect(animate).toHaveBeenCalled()
    expect(container.querySelector('[data-morph="out"]')).toBeNull()
    expect(container).toHaveTextContent('one three')
    expect(screen.queryByText('one two three')).toBeNull()
  })

  it('keeps the outgoing line hidden from assistive tech and out of the way while it plays', async () => {
    let finish = (): void => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    stubAnimate(() => ({ finished, cancel: vi.fn() }))
    const { rerender, container } = render(
      <MorphLine level="brief" tokens={null}>
        old line
      </MorphLine>
    )
    await act(async () => {
      rerender(
        <MorphLine level="key" tokens={null}>
          new line
        </MorphLine>
      )
    })
    const outgoing = container.querySelector('[data-morph="out"]')
    expect(outgoing).toHaveAttribute('aria-hidden', 'true')
    expect(outgoing).toHaveClass('pointer-events-none')
    expect(container.querySelector('[data-morph="in"]')).toHaveTextContent('new line')
    await act(async () => finish())
    expect(container.querySelector('[data-morph]')).toBeNull()
    expect(container).toHaveTextContent('new line')
  })

  it('plays nothing under reduced motion', () => {
    const animate = vi.fn()
    stubAnimate(animate)
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const { rerender, container } = render(
      <MorphLine level="brief" tokens={null}>
        a
      </MorphLine>
    )
    rerender(
      <MorphLine level="key" tokens={null}>
        b
      </MorphLine>
    )
    expect(animate).not.toHaveBeenCalled()
    expect(container.querySelector('[data-morph]')).toBeNull()
  })
})
