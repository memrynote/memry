import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STATUS_CATEGORIES } from '@memry/contracts/property-types'
import { OptionCell } from './option-cells'

const mocks = vi.hoisted(() => ({ options: vi.fn() }))

vi.mock('@/hooks/use-property-options', () => ({ usePropertyOptions: mocks.options }))

const statusOptions = [
  { value: 'Not started', color: 'stone' },
  { value: 'In Progress', color: 'amber' },
  { value: 'Done', color: 'emerald' }
]

describe('folder view select and status pills', () => {
  beforeEach(() => {
    mocks.options.mockReturnValue({
      options: [
        { value: 'Draft', color: 'sky' },
        { value: 'Live', color: 'emerald' }
      ],
      categories: DEFAULT_STATUS_CATEGORIES,
      statusOptions
    })
  })

  it('shows a status as a pill in the colour its option has', () => {
    render(<OptionCell type="status" value="In Progress" propertyName="Status" />)

    const pill = screen.getByText('In Progress')
    expect(pill).toHaveClass('rounded-[10px]')
    expect(pill.getAttribute('style')).toContain('color')
    expect(mocks.options).toHaveBeenCalledWith('Status')
  })

  it('gives each status option its own colour', () => {
    const { rerender } = render(<OptionCell type="status" value="Done" propertyName="Status" />)
    const done = screen.getByText('Done').getAttribute('style')

    rerender(<OptionCell type="status" value="In Progress" propertyName="Status" />)
    expect(screen.getByText('In Progress').getAttribute('style')).not.toBe(done)
  })

  it('shows a select value as a pill and a value the definition dropped in grey', () => {
    const { rerender } = render(<OptionCell type="select" value="Draft" propertyName="Stage" />)
    const draft = screen.getByText('Draft').getAttribute('style')

    rerender(<OptionCell type="select" value="Retired" propertyName="Stage" />)
    expect(screen.getByText('Retired')).toBeInTheDocument()
    expect(screen.getByText('Retired').getAttribute('style')).not.toBe(draft)
  })

  it('shows each multiselect name as a pill and collapses the rest into a count', () => {
    render(<OptionCell type="multiselect" value={['a', 'b', 'c', 'd', 'e']} propertyName="Tags" />)

    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('c')).toBeInTheDocument()
    expect(screen.queryByText('d')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('shows a dash for an empty value and grey pills without a property name', () => {
    const { rerender } = render(<OptionCell type="status" value={null} propertyName="Status" />)
    expect(screen.getByText('—')).toBeInTheDocument()

    rerender(<OptionCell type="select" value="Draft" />)
    expect(screen.getByText('Draft')).toBeInTheDocument()
    expect(mocks.options).toHaveBeenLastCalledWith(undefined)
  })
})
