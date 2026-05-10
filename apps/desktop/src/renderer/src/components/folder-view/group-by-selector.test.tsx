import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { GroupBySelector } from './group-by-selector'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    id
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    id?: string
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  )
}))

describe('GroupBySelector', () => {
  const onGroupByChange = vi.fn()
  const builtInColumns = [
    { id: 'folder', displayName: 'Folder', type: 'text' },
    { id: 'title', displayName: 'Title', type: 'text' },
    { id: 'created', displayName: 'Created', type: 'date' }
  ]
  const availableProperties = [
    { name: 'priority', type: 'select', usageCount: 3 },
    { name: 'body', type: 'rich-text', usageCount: 1 }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists groupable built-in and custom fields, then selects a property', () => {
    render(
      <GroupBySelector
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onGroupByChange={onGroupByChange}
      />
    )

    expect(screen.getByText('Folder')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.queryByText('Title')).not.toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.queryByText('Body')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Priority'))
    expect(onGroupByChange).toHaveBeenCalledWith({
      property: 'priority',
      direction: 'asc',
      collapsed: false,
      showSummary: false
    })
  })

  it('filters, toggles options, and clears existing grouping', () => {
    render(
      <GroupBySelector
        groupBy={{ property: 'folder', direction: 'asc', collapsed: false, showSummary: false }}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onGroupByChange={onGroupByChange}
      />
    )

    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsFolderViewGroupBySelector.searchProperties'),
      { target: { value: 'missing' } }
    )
    expect(
      screen.getByText('phaseF.componentsFolderViewGroupBySelector.noGroupablePropertiesFound')
    ).toBeInTheDocument()

    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsFolderViewGroupBySelector.searchProperties'),
      { target: { value: '' } }
    )
    fireEvent.click(screen.getByText('A → Z'))
    expect(onGroupByChange).toHaveBeenCalledWith({
      property: 'folder',
      direction: 'desc',
      collapsed: false,
      showSummary: false
    })

    fireEvent.click(
      screen.getByLabelText('phaseF.componentsFolderViewGroupBySelector.collapseGroupsByDefault')
    )
    expect(onGroupByChange).toHaveBeenCalledWith({
      property: 'folder',
      direction: 'asc',
      collapsed: true,
      showSummary: false
    })

    fireEvent.click(
      screen.getByLabelText('phaseF.componentsFolderViewGroupBySelector.clearGrouping')
    )
    expect(onGroupByChange).toHaveBeenCalledWith(undefined)
  })
})
