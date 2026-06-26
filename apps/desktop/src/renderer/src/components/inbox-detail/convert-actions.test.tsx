import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@tests/utils/render'

import { ConvertActions } from './convert-actions'
import type { InboxItem } from '@/types'

// i18n: return the last key segment so button labels are predictable.
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) || key
  })
}))

const baseItem = { id: 'item-1', type: 'note' } as unknown as InboxItem

describe('ConvertActions', () => {
  it('enables all convert actions for a text item', () => {
    renderWithProviders(<ConvertActions item={baseItem} onConverted={vi.fn()} />)
    expect(screen.getByRole('button', { name: /note/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /task/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /event/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /reminder/i })).toBeEnabled()
  })

  it('disables Task/Event/Reminder for binary items, Note stays enabled', () => {
    renderWithProviders(
      <ConvertActions item={{ ...baseItem, type: 'pdf' }} onConverted={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /note/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /task/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /event/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /reminder/i })).toBeDisabled()
  })
})
