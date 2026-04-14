import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWrapper } from '@tests/utils/render'
import { useCalendarRange } from './use-calendar-range'

const { mockGetRange, mockOnCalendarChanged, state } = vi.hoisted(() => ({
  mockGetRange: vi.fn(),
  mockOnCalendarChanged: vi.fn(),
  state: {
    calendarChangedHandler: null as ((event: { entityType: string; id: string }) => void) | null
  }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    getRange: mockGetRange
  },
  onCalendarChanged: mockOnCalendarChanged
}))

describe('useCalendarRange', () => {
  beforeEach(() => {
    state.calendarChangedHandler = null
    mockGetRange.mockReset()
    mockOnCalendarChanged.mockReset()
    mockOnCalendarChanged.mockImplementation((callback) => {
      state.calendarChangedHandler = callback
      return () => {}
    })
  })

  it('refetches the range when calendar data changes', async () => {
    mockGetRange.mockResolvedValue({ items: [] })

    const { result } = renderHook(
      () =>
        useCalendarRange({
          startAt: '2026-04-12T00:00:00.000Z',
          endAt: '2026-04-19T00:00:00.000Z',
          includeUnselectedSources: true
        }),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(result.current.items).toEqual([])
    })

    expect(mockGetRange).toHaveBeenCalledTimes(1)

    act(() => {
      state.calendarChangedHandler?.({ entityType: 'projection', id: 'projection:1' })
    })

    await waitFor(() => {
      expect(mockGetRange).toHaveBeenCalledTimes(2)
    })
  })
})
