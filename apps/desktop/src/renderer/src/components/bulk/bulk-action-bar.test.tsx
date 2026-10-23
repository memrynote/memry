import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { BulkActionBar } from './bulk-action-bar'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('/')}` : key
  })
}))

vi.mock('@/components/snooze', () => ({
  SnoozePicker: ({
    trigger,
    onSnooze
  }: {
    trigger: React.ReactNode
    onSnooze: (snoozeUntil: string) => void
  }) => (
    <div>
      {trigger}
      <button type="button" onClick={() => onSnooze('2026-05-11T09:00:00.000Z')}>
        choose snooze
      </button>
    </div>
  )
}))

describe('BulkActionBar', () => {
  it('hides when no items are selected', () => {
    const { container } = render(
      <BulkActionBar
        selectedCount={0}
        onFileAll={vi.fn()}
        onTagAll={vi.fn()}
        onArchiveAll={vi.fn()}
        aiSuggestion={null}
        onAddSuggestionToSelection={vi.fn()}
        onDismissSuggestion={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('runs primary bulk actions and disables snooze when no handler is provided', async () => {
    const user = userEvent.setup()
    const onFileAll = vi.fn()
    const onTagAll = vi.fn()
    const onArchiveAll = vi.fn()

    render(
      <BulkActionBar
        selectedCount={3}
        onFileAll={onFileAll}
        onTagAll={onTagAll}
        onArchiveAll={onArchiveAll}
        aiSuggestion={null}
        onAddSuggestionToSelection={vi.fn()}
        onDismissSuggestion={vi.fn()}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'bulk.ariaLabel:3' })).toBeInTheDocument()
    expect(screen.getByText('bulk.selected:3')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'bulk.file' }))
    await user.click(screen.getByRole('button', { name: 'bulk.tag' }))
    await user.click(screen.getByRole('button', { name: 'bulk.archive' }))

    expect(onFileAll).toHaveBeenCalledTimes(1)
    expect(onTagAll).toHaveBeenCalledTimes(1)
    expect(onArchiveAll).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'bulk.snooze' })).toBeDisabled()
    expect(screen.getByText('bulk.hint.deselect')).toBeInTheDocument()
  })

  it('renders snooze and AI suggestion actions when available', async () => {
    const user = userEvent.setup()
    const onSnoozeAll = vi.fn()
    const onAddSuggestionToSelection = vi.fn()
    const onDismissSuggestion = vi.fn()

    render(
      <BulkActionBar
        selectedCount={2}
        onFileAll={vi.fn()}
        onTagAll={vi.fn()}
        onSnoozeAll={onSnoozeAll}
        onArchiveAll={vi.fn()}
        aiSuggestion={{
          reason: 'same project and tags',
          items: [{ id: 'inbox-1' }, { id: 'inbox-2' }] as never
        }}
        onAddSuggestionToSelection={onAddSuggestionToSelection}
        onDismissSuggestion={onDismissSuggestion}
      />
    )

    await user.click(screen.getByRole('button', { name: 'choose snooze' }))
    expect(onSnoozeAll).toHaveBeenCalledWith('2026-05-11T09:00:00.000Z')

    expect(screen.getByText('same project and tags')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'bulk.add' }))
    await user.click(screen.getByRole('button', { name: 'bulk.dismissSuggestion' }))

    expect(onAddSuggestionToSelection).toHaveBeenCalledTimes(1)
    expect(onDismissSuggestion).toHaveBeenCalledTimes(1)
  })
})
