import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProjectLinkedEvent, ProjectLinkedFile, ProjectLinkedNote } from '@memry/rpc/tasks'
import type { ProjectHubData } from '../use-project-hub'
import type { HubHandlers } from './hub-handlers'
import { ListTab } from './list-tab'

const noop = (): void => {}

const handlers: HubHandlers = {
  onGoToTab: noop,
  onOpenTask: noop,
  onStatusChange: noop,
  onToggleComplete: noop,
  onPriorityChange: noop,
  onOpenNote: noop,
  onNoteIconChange: noop,
  onOpenFile: noop,
  onOpenEvent: noop,
  onAddTask: noop,
  onAddNote: noop,
  onAddFile: noop,
  onAddEvent: noop
}

const at = (dayOffset: number, hour = 12): string => {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  date.setDate(date.getDate() + dayOffset)
  return date.toISOString()
}

const note = (id: string, modifiedAt: string): ProjectLinkedNote => ({
  id,
  title: id,
  emoji: null,
  modifiedAt,
  pinned: false
})

const file = (id: string, modifiedAt: string): ProjectLinkedFile => ({
  id,
  title: id,
  fileType: 'image',
  mimeType: 'image/png',
  fileSize: null,
  modifiedAt
})

const event = (id: string, startAt: string): ProjectLinkedEvent => ({
  id,
  title: id,
  startAt,
  endAt: null,
  isAllDay: true
})

const hubWith = (patch: Partial<ProjectHubData>): ProjectHubData => ({
  project: null,
  tasks: [],
  notes: [],
  pinnedNotes: [],
  files: [],
  events: [],
  counts: { tasks: 0, notes: 0, files: 0, events: 0 },
  progress: { done: 0, total: 0, pct: 0, statuses: [], overdue: 0 },
  homeNoteId: null,
  createdAt: null,
  modifiedAt: null,
  isLoading: false,
  refresh: noop,
  ...patch
})

describe('ListTab', () => {
  it('groups notes into the inbox time sections', () => {
    const hub = hubWith({
      notes: [note('fresh', at(0)), note('stale', at(-8))],
      counts: { tasks: 0, notes: 2, files: 0, events: 0 }
    })

    render(<ListTab kind="notes" hub={hub} handlers={handlers} />)

    const today = screen.getByRole('region', { name: /^Today/ })
    const older = screen.getByRole('region', { name: /^Older/ })
    expect(within(today).getByText('fresh')).toBeInTheDocument()
    expect(within(older).getByText('stale')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /^Yesterday/ })).not.toBeInTheDocument()
  })

  it('groups files by modified date', () => {
    const hub = hubWith({
      files: [file('yesterdays.png', at(-1))],
      counts: { tasks: 0, notes: 0, files: 1, events: 0 }
    })

    render(<ListTab kind="files" hub={hub} handlers={handlers} />)

    const yesterday = screen.getByRole('region', { name: /^Yesterday/ })
    expect(within(yesterday).getByText('yesterdays.png')).toBeInTheDocument()
  })

  it('gives events forward-facing sections instead of "Older"', () => {
    const hub = hubWith({
      events: [event('standup', at(1)), event('retro', at(6)), event('kickoff', at(-4))],
      counts: { tasks: 0, notes: 0, files: 0, events: 3 }
    })

    render(<ListTab kind="events" hub={hub} handlers={handlers} />)

    expect(
      within(screen.getByRole('region', { name: /^Tomorrow/ })).getByText('standup')
    ).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: /^Upcoming/ })).getByText('retro')
    ).toBeVisible()
    expect(within(screen.getByRole('region', { name: /^Past/ })).getByText('kickoff')).toBeVisible()
    expect(screen.queryByRole('region', { name: /^Older/ })).not.toBeInTheDocument()
  })

  it('collapses a section without losing the others', async () => {
    const hub = hubWith({
      notes: [note('fresh', at(0)), note('stale', at(-8))],
      counts: { tasks: 0, notes: 2, files: 0, events: 0 }
    })

    render(<ListTab kind="notes" hub={hub} handlers={handlers} />)

    await userEvent.click(screen.getByRole('button', { name: /^Today/ }))
    expect(screen.queryByText('fresh')).not.toBeInTheDocument()
    expect(screen.getByText('stale')).toBeInTheDocument()
  })

  it('shows the empty line and no sections when nothing is linked', async () => {
    const onAddNote = vi.fn()
    render(<ListTab kind="notes" hub={hubWith({})} handlers={{ ...handlers, onAddNote }} />)

    expect(screen.getByText('No notes linked yet.')).toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /add to notes/i }))
    expect(onAddNote).toHaveBeenCalled()
  })
})
