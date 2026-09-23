import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarItemChip } from './calendar-item-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  uncomplete: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key
  })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { complete: mocks.complete, uncomplete: mocks.uncomplete }
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

const NOW = new Date('2026-05-14T08:00:00')

function eventItem(overrides: Partial<CalendarProjectionItem> = {}): CalendarProjectionItem {
  return {
    projectionId: 'projection-1',
    sourceId: 'event-1',
    sourceType: 'event',
    visualType: 'event',
    title: 'Planning',
    descriptionPreview: null,
    startAt: '2026-05-14T09:00',
    endAt: '2026-05-14T10:30',
    isAllDay: false,
    timezone: 'UTC',
    color: null,
    source: {
      provider: null,
      calendarSourceId: null,
      title: null,
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null,
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    ...overrides
  } as CalendarProjectionItem
}

function chipOf(title = 'Planning'): HTMLElement {
  return screen.getByText(title).closest('[data-visual-type]') as HTMLElement
}

describe('CalendarItemChip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.complete.mockResolvedValue({ id: 'task-1' })
    mocks.uncomplete.mockResolvedValue({ id: 'task-1' })
  })

  it('renders a static chip when no item actions are available', () => {
    render(<CalendarItemChip item={eventItem()} now={NOW} />)

    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('paints the item-type hue through theme tokens, with a rail and ink title', () => {
    render(<CalendarItemChip item={eventItem()} now={NOW} />)

    const chip = chipOf()
    expect(chip.style.getPropertyValue('--chip-rail')).toBe('var(--cal-indigo-rail)')
    expect(chip.style.getPropertyValue('--chip-surface')).toBe('var(--cal-indigo-surface)')
    expect(chip).toHaveClass('bg-(--chip-surface)', 'text-(--cal-ink)')
    expect(chip.querySelector('[data-chip-rail]')).toHaveClass('bg-(--chip-rail)')
    expect(chip).not.toHaveAttribute('data-event-color')
  })

  it('tints a coloured event with its own colour', () => {
    render(
      <CalendarItemChip item={eventItem({ color: 'sage', displayColor: '#33b679' })} now={NOW} />
    )

    const chip = chipOf()
    expect(chip).toHaveAttribute('data-event-color', '#33b679')
    expect(chip.style.getPropertyValue('--chip-rail')).toBe('#33b679')
    expect(chip.style.getPropertyValue('--chip-surface')).toBe(
      'color-mix(in srgb, #33b679 25%, var(--background))'
    )
  })

  it('goes solid with readable ink when selected', () => {
    render(
      <CalendarItemChip
        item={eventItem({ color: 'tomato', displayColor: '#d50000' })}
        now={NOW}
        isSelected
      />
    )

    const chip = chipOf()
    expect(chip).toHaveAttribute('data-selected', 'true')
    expect(chip).toHaveClass('bg-(--chip-solid)', 'text-(--chip-solid-ink)')
    expect(chip.style.getPropertyValue('--chip-solid-ink')).toBe('#ffffff')
  })

  it('stacks time range and duration under the title for a tall timed block', () => {
    render(<CalendarItemChip item={eventItem()} layout="block" clockFormat="24h" now={NOW} />)

    expect(
      screen.getByText(/09:00 – 10:30 · chip.duration-hours-minutes:\{"hours":1,"minutes":30\}/)
    ).toBeInTheDocument()
  })

  it('keeps a short block on one line with only its start time', () => {
    render(
      <CalendarItemChip
        item={eventItem({ endAt: '2026-05-14T09:30' })}
        layout="block"
        clockFormat="24h"
        now={NOW}
      />
    )

    expect(screen.getByText('09:00')).toBeInTheDocument()
    expect(screen.queryByText(/chip.duration/)).not.toBeInTheDocument()
  })

  it('fades a timed event once it has ended, but not a past-due task', () => {
    const { rerender } = render(
      <CalendarItemChip item={eventItem()} now={new Date('2026-05-14T11:00:00')} />
    )
    expect(chipOf()).toHaveClass('opacity-60')
    expect(chipOf()).toHaveAttribute('data-ended', 'true')

    rerender(
      <CalendarItemChip
        item={eventItem({ sourceType: 'task', visualType: 'task', sourceId: 'task-1' })}
        now={new Date('2026-05-14T11:00:00')}
      />
    )
    expect(chipOf()).not.toHaveClass('opacity-60')
  })

  it('fades a fired (triggered) note_date chip and draws it as a dashed outline', () => {
    render(
      <CalendarItemChip
        item={eventItem({ sourceType: 'note_date', visualType: 'note_date', isTriggered: true })}
        now={NOW}
      />
    )

    const chip = chipOf()
    expect(chip).toHaveAttribute('data-triggered', 'true')
    expect(chip).toHaveClass('opacity-60', 'border-dashed')
  })

  it('opens the item from the chip face, anchored to the whole chip', () => {
    const onClick = vi.fn()
    render(<CalendarItemChip item={eventItem()} now={NOW} onClick={onClick} />)

    fireEvent.click(screen.getByRole('button', { name: /Planning/ }))
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'event-1' }),
      expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) })
    )
  })

  it('completes a task from its chip checkbox without opening it, with undo', async () => {
    const onClick = vi.fn()
    const onParentMouseDown = vi.fn()
    render(
      <div onMouseDown={onParentMouseDown}>
        <CalendarItemChip
          item={eventItem({ sourceType: 'task', visualType: 'task', sourceId: 'task-1' })}
          now={NOW}
          onClick={onClick}
        />
      </div>
    )

    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toHaveAttribute('aria-checked', 'false')
    fireEvent.mouseDown(checkbox)
    fireEvent.click(checkbox)

    expect(onParentMouseDown).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
    expect(mocks.complete).toHaveBeenCalledWith({ id: 'task-1' })
    expect(checkbox).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())

    const [, options] = mocks.toast.mock.calls[0] as [string, { action: { onClick: () => void } }]
    options.action.onClick()
    expect(mocks.uncomplete).toHaveBeenCalledWith('task-1')
  })

  it('rolls the checkbox back and reports when completing fails', async () => {
    mocks.complete.mockRejectedValueOnce(new Error('offline'))
    render(
      <CalendarItemChip
        item={eventItem({ sourceType: 'task', visualType: 'task', sourceId: 'task-1' })}
        now={NOW}
        onClick={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('checkbox'))

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('offline'))
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
  })

  it('does not offer a checkbox for events', () => {
    render(<CalendarItemChip item={eventItem()} now={NOW} onClick={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
