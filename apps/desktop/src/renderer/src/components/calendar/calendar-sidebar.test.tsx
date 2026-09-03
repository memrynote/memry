import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CalendarSidebar } from './calendar-sidebar'
import type { CalendarSourceRecord } from '@/services/calendar-service'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

function source(overrides: Partial<CalendarSourceRecord>): CalendarSourceRecord {
  return {
    id: 'google-calendar:primary',
    provider: 'google',
    kind: 'calendar',
    accountId: 'work@example.com',
    remoteId: 'work@example.com',
    title: 'Work',
    timezone: 'Europe/Istanbul',
    color: '#0ea5e9',
    isPrimary: true,
    isSelected: true,
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: null,
    lastError: null,
    metadata: null,
    archivedAt: null,
    syncedAt: null,
    createdAt: '2026-08-29T08:00:00.000Z',
    modifiedAt: '2026-08-29T08:00:00.000Z',
    ...overrides
  }
}

const PRIMARY = source({})
const SECONDARY = source({
  id: 'google-calendar:personal',
  remoteId: 'personal@example.com',
  title: 'Personal',
  isPrimary: false,
  isSelected: false
})

function renderSidebar(props: Partial<React.ComponentProps<typeof CalendarSidebar>> = {}) {
  const onToggleImportedSource = vi.fn()
  render(
    <CalendarSidebar
      showMemryItems
      showImportedCalendars
      importedSources={[PRIMARY, SECONDARY]}
      selectedImportedSourceIds={[PRIMARY.id]}
      onToggleMemryItems={vi.fn()}
      onToggleImportedCalendars={vi.fn()}
      onToggleImportedSource={onToggleImportedSource}
      {...props}
    />
  )
  return { onToggleImportedSource }
}

describe('CalendarSidebar', () => {
  it('does not tick a calendar nothing is fetching', () => {
    // The reported bug: discovery only pre-selects the primary calendar, so
    // every other one was listed with a tick beside it and never produced a
    // single event.
    renderSidebar()

    expect(screen.getByRole('checkbox', { name: 'Work' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Personal' })).not.toBeChecked()
  })

  it('says why an unticked calendar is empty', () => {
    renderSidebar()

    const secondaryRow = screen.getByTestId(`calendar-filter-source-${SECONDARY.id}`)
    expect(secondaryRow).toHaveTextContent('filter.not-syncing')

    const primaryRow = screen.getByTestId(`calendar-filter-source-${PRIMARY.id}`)
    expect(primaryRow).not.toHaveTextContent('filter.not-syncing')
  })

  it('reports the toggle so the page can subscribe the calendar', async () => {
    const user = userEvent.setup()
    const { onToggleImportedSource } = renderSidebar()

    await user.click(screen.getByRole('checkbox', { name: 'Personal' }))

    expect(onToggleImportedSource).toHaveBeenCalledWith(SECONDARY.id)
  })
})
