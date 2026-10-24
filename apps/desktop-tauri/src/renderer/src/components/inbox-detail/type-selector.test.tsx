import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@tests/utils/render'

import { TypeSelector } from './type-selector'

// i18n: return the last key segment so labels are predictable.
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) || key
  })
}))

describe('TypeSelector', () => {
  it('enables every type', () => {
    renderWithProviders(<TypeSelector value="note" onChange={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /note/i })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /task/i })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /event/i })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /reminder/i })).toBeEnabled()
  })

  it('reports the selected type and fires onChange on pick', () => {
    const onChange = vi.fn()
    renderWithProviders(<TypeSelector value="task" onChange={onChange} />)
    expect(screen.getByRole('radio', { name: /task/i })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('radio', { name: /event/i }))
    expect(onChange).toHaveBeenCalledWith('event')
  })
})
