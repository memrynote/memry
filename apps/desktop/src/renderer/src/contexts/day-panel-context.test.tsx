import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DayPanelProvider, useDayPanel } from './day-panel-context'

const wrapper = ({ children }: { children: ReactNode }) => (
  <DayPanelProvider>{children}</DayPanelProvider>
)

describe('DayPanelContext task selection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('exposes null selectedTaskId by default', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    expect(result.current.selectedTaskId).toBeNull()
  })

  it('openForTask sets selectedTaskId and opens the panel', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    act(() => result.current.openForTask('task-123'))
    expect(result.current.selectedTaskId).toBe('task-123')
    expect(result.current.isOpen).toBe(true)
  })

  it('close() clears selectedTaskId', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    act(() => result.current.openForTask('task-123'))
    act(() => result.current.close())
    expect(result.current.selectedTaskId).toBeNull()
    expect(result.current.isOpen).toBe(false)
  })

  it('openForDayView clears selectedTaskId', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    act(() => result.current.openForTask('task-123'))
    act(() => result.current.openForDayView('2026-04-29'))
    expect(result.current.selectedTaskId).toBeNull()
    expect(result.current.selectedDate).toBe('2026-04-29')
  })
})
