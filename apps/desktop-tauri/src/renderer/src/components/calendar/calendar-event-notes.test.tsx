import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  title: 'Planning',
  updated: [] as Array<() => void>,
  listLinkedNotes: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { listLinkedNotes: mocks.listLinkedNotes }
}))
vi.mock('@/services/notes-service', () => ({
  notesService: {},
  onNoteUpdated: (cb: () => void) => {
    mocks.updated.push(cb)
    return () => undefined
  },
  onNoteRenamed: () => () => undefined,
  onNoteDeleted: () => () => undefined
}))
vi.mock('@/services/properties-service', () => ({ propertiesService: {} }))
vi.mock('@/components/note/info-section/editors/use-relation-search', () => ({
  useRelationSearch: () => ({ notes: [], loading: false })
}))

import { CalendarEventNotes } from './calendar-event-notes'

describe('CalendarEventNotes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.updated.length = 0
    mocks.title = 'Planning'
    mocks.listLinkedNotes.mockImplementation(async () => ({
      notes: [{ id: 'n1', title: mocks.title, emoji: null }]
    }))
  })
  afterEach(() => vi.useRealTimers())

  it('shows a renamed linked note without a manual refresh', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CalendarEventNotes
          target={{ sourceType: 'event', sourceId: 'e1', title: 'Planning' }}
          onOpenNote={vi.fn()}
        />
      </QueryClientProvider>
    )
    expect(await screen.findByText('Planning')).toBeTruthy()

    mocks.title = 'Planning v2'
    await act(async () => {
      mocks.updated.forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(await screen.findByText('Planning v2')).toBeTruthy()
  })
})
