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
      <button type="button" onClick={() => state.openTag('work', 'blue')}>
        open
      </button>
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

  it('opens tag views, backs out with Escape, and clears transition direction', () => {
    vi.useFakeTimers()
    render(<Probe />, { wrapper })

    expect(screen.getByTestId('view')).toHaveTextContent('main')
    expect(screen.getByTestId('main')).toHaveTextContent('true')

    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('view')).toHaveTextContent('tag')
    expect(screen.getByTestId('main')).toHaveTextContent('false')
    expect(screen.getByTestId('direction')).toHaveTextContent('left')

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByTestId('direction')).toHaveTextContent('none')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('view')).toHaveTextContent('main')
    expect(screen.getByTestId('direction')).toHaveTextContent('right')
  })

  it('keeps main view stable when backing from root and supports explicit reset', () => {
    const { result } = renderHook(() => useSidebarDrillDown(), { wrapper })

    act(() => result.current.goBack())
    expect(result.current.viewStack).toEqual([{ type: 'main' }])
    expect(result.current.animationDirection).toBe('right')

    act(() => result.current.openTag('personal', 'green'))
    expect(result.current.currentView).toEqual({ type: 'tag', tag: 'personal', color: 'green' })

    act(() => result.current.resetToMain())
    expect(result.current.currentView).toEqual({ type: 'main' })
  })

  it('throws when the hook is used outside the provider', () => {
    expect(() => renderHook(() => useSidebarDrillDown())).toThrow(
      'useSidebarDrillDown must be used within a SidebarDrillDownProvider'
    )
  })
})
