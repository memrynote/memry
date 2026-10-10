import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FilterRow } from './filter-row'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <div data-value={value}>{children}</div>
  )
}))

function itemIcon(container: HTMLElement, value: string): string {
  const svg = container.querySelector(`[data-value="${value}"] svg`)
  if (!svg) throw new Error(`no icon for ${value}`)
  return svg.innerHTML
}

describe('FilterRow property icons', () => {
  it('shows the icon of the property type for custom properties', () => {
    const { container } = render(
      <FilterRow
        condition={{ id: 'c1', property: 'due', operator: 'is', value: '' }}
        availableProperties={[
          { id: 'due', name: 'Due', type: 'date' },
          { id: 'pages', name: 'Pages', type: 'number' },
          { id: 'summary', name: 'Summary', type: 'text' }
        ]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />
    )

    // Built-in `created` is a date column (calendar), `wordCount` a number column (hash).
    expect(itemIcon(container, 'due')).toBe(itemIcon(container, 'created'))
    expect(itemIcon(container, 'pages')).toBe(itemIcon(container, 'wordCount'))
    expect(itemIcon(container, 'due')).not.toBe(itemIcon(container, 'summary'))
  })

  it('falls back to the generic icon for a stored type without its own icon', () => {
    const { container } = render(
      <FilterRow
        condition={{ id: 'c1', property: 'title', operator: 'contains', value: '' }}
        // `status` is a stored property type the filter's PropertyType union does not list.
        availableProperties={[
          { id: 'stage', name: 'Stage', type: 'status' as unknown as 'text' },
          { id: 'unknownType', name: 'Unknown', type: undefined as unknown as 'text' }
        ]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />
    )

    expect(itemIcon(container, 'stage')).toBe(itemIcon(container, 'unknownType'))
  })
})
