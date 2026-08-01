import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilterBuilder } from './filter-builder'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) || key })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <label>
      select
      <select
        aria-label="logic select"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="and">and</option>
        <option value="or">or</option>
      </select>
      {children}
    </label>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <span data-value={value}>{children}</span>
  )
}))

vi.mock('./filter-row', () => ({
  FilterRow: ({
    condition,
    onChange,
    onRemove,
    nestingLevel = 0
  }: {
    condition: { id: string; property: string; operator: string; value: unknown }
    onChange: (condition: {
      id: string
      property: string
      operator: string
      value: unknown
    }) => void
    onRemove: () => void
    nestingLevel?: number
  }) => (
    <div>
      <span>
        row {nestingLevel} {condition.property} {condition.operator} {String(condition.value ?? '')}
      </span>
      <button
        type="button"
        onClick={() =>
          onChange({ ...condition, property: 'status', operator: '==', value: 'done' })
        }
      >
        update {condition.id}
      </button>
      <button type="button" onClick={onRemove}>
        remove {condition.id}
      </button>
    </div>
  )
}))

const builtInColumns = [
  { id: 'title', displayName: 'Title', type: 'text' },
  { id: 'status', displayName: 'Status', type: 'text' }
]

const availableProperties = [{ name: 'priority', type: 'number', usageCount: 4 }]

function flushDebounce() {
  act(() => {
    vi.advanceTimersByTime(250)
  })
}

describe('FilterBuilder', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adds, updates, groups, and clears filters through debounced saves', () => {
    const onFiltersChange = vi.fn()

    render(
      <FilterBuilder
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onFiltersChange={onFiltersChange}
      />
    )

    expect(screen.queryByText(/^row /)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /addFilter/ }))
    flushDebounce()
    expect(onFiltersChange).toHaveBeenLastCalledWith('title == ""')
    expect(screen.getByText(/row 0 title ==/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /update cond_/ }))
    flushDebounce()
    expect(onFiltersChange).toHaveBeenLastCalledWith('status == "done"')

    fireEvent.click(screen.getByRole('button', { name: /addGroup/ }))
    flushDebounce()
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      and: ['status == "done"', 'title == ""']
    })

    fireEvent.change(screen.getAllByLabelText('logic select')[0], { target: { value: 'or' } })
    flushDebounce()
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      or: ['status == "done"', 'title == ""']
    })

    // No clear-all button anymore — clear by removing the condition then the group.
    fireEvent.click(screen.getAllByRole('button', { name: /remove cond_/ })[0])
    flushDebounce()
    expect(onFiltersChange).toHaveBeenLastCalledWith('title == ""')

    fireEvent.click(screen.getByRole('button', { name: /removeGroup/ }))
    flushDebounce()
    expect(onFiltersChange).toHaveBeenLastCalledWith(undefined)
  })

  it('hydrates string and nested filters and responds to external filter prop changes', () => {
    const onFiltersChange = vi.fn()
    const { unmount } = render(
      <FilterBuilder
        filters={{ or: ['status == "todo"', { and: ['priority > 2', 'title contains "plan"'] }] }}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onFiltersChange={onFiltersChange}
      />
    )

    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/row 0 status == todo/)).toBeInTheDocument()
    expect(screen.getByText(/row 0 priority > 2/)).toBeInTheDocument()
    expect(screen.getByText(/row 0 title contains plan/)).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /remove cond_/ })[1])
    flushDebounce()
    expect(onFiltersChange).toHaveBeenCalledWith({
      or: ['status == "todo"', 'title contains "plan"']
    })

    unmount()
    render(
      <FilterBuilder
        filters={'title contains "memo"'}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onFiltersChange={onFiltersChange}
      />
    )

    expect(screen.getByText(/row 0 title contains memo/)).toBeInTheDocument()
  })

  it('renders the locked condition with no remove control', () => {
    render(
      <FilterBuilder
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onFiltersChange={vi.fn()}
        lockedCondition={{ label: 'tag = araba' }}
      />
    )

    const lockedRow = screen.getByTestId('locked-filter-row')
    expect(lockedRow).toHaveTextContent('tag = araba')
    expect(within(lockedRow).queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
  })

  it('never emits the locked condition as part of the filter expression', () => {
    const onFiltersChange = vi.fn()
    render(
      <FilterBuilder
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onFiltersChange={onFiltersChange}
        lockedCondition={{ label: 'tag = araba' }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /addFilter/ }))
    flushDebounce()
    fireEvent.click(screen.getByRole('button', { name: /update cond_/ }))
    flushDebounce()

    expect(onFiltersChange).toHaveBeenLastCalledWith('status == "done"')
    expect(JSON.stringify(onFiltersChange.mock.calls)).not.toContain('araba')
  })

  it('excludes the locked condition from the filter-count badge', () => {
    render(
      <FilterBuilder
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onFiltersChange={vi.fn()}
        filters={'status == "todo"'}
        lockedCondition={{ label: 'tag = araba' }}
      />
    )

    // Badge reflects only the real filter expression (1 condition) — the
    // locked row never enters `filters`, so it must not be counted as a 2nd.
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
  })
})
