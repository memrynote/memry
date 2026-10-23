import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarDrillDownProvider, useSidebarDrillDown } from './sidebar-drill-down'

function wrapper({ children }: { children: ReactNode }) {
  return <SidebarDrillDownProvider>{children}</SidebarDrillDownProvider>
}

function Probe() {
  const state = useSidebarDrillDown()
  return (
    <div>
      <output data-testid="view">{state.currentView.type}</output>
      <output data-testid="main">{String(state.isAtMain)}</output>
      <output data-testid="direction">{state.animationDirection ?? 'none'}</output>
      <button type="button" onClick={state.goBack}>
        back
      </button>
      <button type="button" onClick={state.resetToMain}>
        reset
      </button>
    </div>
  )
}

describe('SidebarDrillDownProvider', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('starts at the main view and clears transition direction after a reset', () => {
    vi.useFakeTimers()
    render(<Probe />, { wrapper })

    expect(screen.getByTestId('view')).toHaveTextContent('main')
    expect(screen.getByTestId('main')).toHaveTextContent('true')

    fireEvent.click(screen.getByText('reset'))
    expect(screen.getByTestId('direction')).toHaveTextContent('right')

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByTestId('direction')).toHaveTextContent('none')
  })

  it('keeps main view stable when backing from or resetting the root', () => {
    const { result } = renderHook(() => useSidebarDrillDown(), { wrapper })

    act(() => result.current.goBack())
    expect(result.current.viewStack).toEqual([{ type: 'main' }])
    expect(result.current.animationDirection).toBe('right')

    act(() => result.current.resetToMain())
    expect(result.current.currentView).toEqual({ type: 'main' })
  })

  it('throws when the hook is used outside the provider', () => {
    expect(() => renderHook(() => useSidebarDrillDown())).toThrow(
      'useSidebarDrillDown must be used within a SidebarDrillDownProvider'
    )
  })
})
