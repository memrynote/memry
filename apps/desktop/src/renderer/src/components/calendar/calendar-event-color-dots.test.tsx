import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders, userEvent } from '@tests/utils/render'

import { CalendarSearch } from './calendar-search'
import { CalendarYearView } from './calendar-year-view'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const { mockGetRange } = vi.hoisted(() => ({ mockGetRange: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '12h' } })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getRange: mockGetRange }
}))

function event(
  title: string,
  displayColor: string | null,
  startAt = '2026-05-10T09:00:00.000Z'
): CalendarProjectionItem {
  return {
    projectionId: `event:${title}`,
    sourceType: 'event',
    sourceId: title,
    title,
    descriptionPreview: null,
    startAt,
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: 'memrynote',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null,
    color: null,
    displayColor
  }
}

function dotBeside(title: string): HTMLElement {
  const dot = screen.getByText(title).closest('button')?.querySelector('span')
  if (!dot) throw new Error(`no dot beside ${title}`)
  return dot
}

describe('event colour dots', () => {
  it('colours the year view day list by display colour', () => {
    vi.useFakeTimers()
    try {
      render(
        <CalendarYearView
          anchorDate="2026-05-10"
          items={[event('Standup', '#d50000'), event('Review', null)]}
          onViewChange={vi.fn()}
          onAnchorChange={vi.fn()}
        />
      )
      fireEvent.click(screen.getAllByRole('button', { name: /Sunday, May 10/i })[0])
      act(() => vi.advanceTimersByTime(250))

      expect(dotBeside('Standup').style.backgroundColor).toBe('rgb(213, 0, 0)')
      expect(dotBeside('Review').style.backgroundColor).toBe('rgb(146, 206, 212)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('colours a search result by display colour', async () => {
    mockGetRange.mockResolvedValue({
      items: [event('Standup', '#3f51b5', new Date().toISOString())]
    })
    const user = userEvent.setup()
    renderWithProviders(<CalendarSearch onJump={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'search.open' }))
    await user.type(screen.getByRole('textbox'), 'stand')

    const result = await screen.findByText('Standup')
    const dot = result.closest('button')?.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(dot.style.backgroundColor).toBe('rgb(63, 81, 181)')
  })
})
