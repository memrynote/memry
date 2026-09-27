import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LayoutToggle } from './layout-toggle'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

describe('LayoutToggle', () => {
  it('marks the active layout as pressed', () => {
    render(<LayoutToggle value="grid" onChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'gallery' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'table' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports a new layout and ignores the active one', () => {
    const onChange = vi.fn()
    render(<LayoutToggle value="table" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'table' }))
    fireEvent.click(screen.getByRole('button', { name: 'gallery' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('grid')
  })
})
