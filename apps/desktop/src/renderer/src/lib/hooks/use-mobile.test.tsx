import { Activity } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIsMobile } from './use-mobile'

function Probe() {
  return <span data-testid="mobile">{String(useIsMobile())}</span>
}

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

describe('useIsMobile', () => {
  const originalWidth = window.innerWidth

  afterEach(() => {
    setWidth(originalWidth)
    vi.restoreAllMocks()
  })

  it('reads the current width when a hidden tree is shown again', () => {
    setWidth(1200)
    const view = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <Probe />
      </Activity>
    )
    const { rerender } = render(view('visible'))
    expect(screen.getByTestId('mobile')).toHaveTextContent('false')

    // Narrowed and widened again while hidden: no listener saw either change.
    rerender(view('hidden'))
    setWidth(600)
    setWidth(1200)
    act(() => rerender(view('visible')))

    expect(screen.getByTestId('mobile')).toHaveTextContent('false')

    setWidth(600)
    act(() => rerender(view('hidden')))
    act(() => rerender(view('visible')))
    expect(screen.getByTestId('mobile')).toHaveTextContent('true')
  })
})
