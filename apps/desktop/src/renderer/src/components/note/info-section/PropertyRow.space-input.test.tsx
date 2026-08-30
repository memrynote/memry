/**
 * "Properties do not allow spaces anymore": typing `movie series` into a
 * property field produced `movieseries`.
 *
 * Unlike PropertyRow.test.tsx these render the real editors. The bug lived in
 * the row's own `role="button"` value wrapper, so any test that stubs the
 * editors out cannot see it.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PropertyRow } from './PropertyRow'
import type { Property } from './types'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  addPropertyOption: vi.fn(),
  addStatusOption: vi.fn(),
  removePropertyOption: vi.fn(),
  isEnabled: vi.fn(() => false),
  setEnabled: vi.fn()
}))

vi.mock('@/hooks/use-calendar-properties', () => ({
  useCalendarProperties: () => ({
    isEnabled: mocks.isEnabled,
    setEnabled: mocks.setEnabled
  })
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false
  })
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } }
}))

vi.mock('@/hooks/use-projects-list', () => ({
  useProjectsList: () => ({ projects: [], isLoading: false })
}))

vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: () => ({
    refresh: mocks.refresh,
    getDefinition: () => ({ options: JSON.stringify([]) })
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    addPropertyOption: mocks.addPropertyOption,
    addStatusOption: mocks.addStatusOption,
    removePropertyOption: mocks.removePropertyOption
  }
}))

const TWO_WORDS = 'movie series'

const property = (overrides: Partial<Property> = {}): Property => ({
  id: 'prop-1',
  name: 'Genre',
  type: 'text',
  value: '',
  isCustom: true,
  ...overrides
})

describe('PropertyRow space handling', () => {
  it('keeps the space when typing into a text property value', async () => {
    const user = userEvent.setup()

    render(<PropertyRow property={property()} onValueChange={vi.fn()} autoFocus />)

    const input = screen.getByRole('textbox', { name: 'Empty' })
    await user.type(input, TWO_WORDS)

    expect(input).toHaveValue(TWO_WORDS)
  })

  // The picker is portalled onto document.body, but React still routes its
  // keydown through the row's value wrapper, so this input shares the bug.
  it('keeps the space when naming a new select option', async () => {
    const user = userEvent.setup()

    render(
      <PropertyRow
        property={property({ type: 'select', value: null })}
        onValueChange={vi.fn()}
        autoFocus
      />
    )

    await user.click(screen.getByRole('button', { name: 'New option' }))

    const input = screen.getByRole('textbox', { name: 'Option name' })
    await user.type(input, TWO_WORDS)

    expect(input).toHaveValue(TWO_WORDS)
  })

  it('still starts editing when Enter or Space lands on the value wrapper itself', async () => {
    const user = userEvent.setup()

    render(<PropertyRow property={property({ value: 'Drama' })} onValueChange={vi.fn()} />)

    const wrapper = screen.getByRole('button', { name: 'Drama' })
    wrapper.focus()
    await user.keyboard(' ')

    expect(screen.getByRole('textbox', { name: 'Empty' })).toBeInTheDocument()
  })
})
