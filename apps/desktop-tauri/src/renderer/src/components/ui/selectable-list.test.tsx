import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SelectableListItem,
  SelectableListSection,
  StandaloneSelectableItem
} from './selectable-list'

describe('selectable-list', () => {
  it('renders collapsible sections, selected items, icons, badges, and callbacks', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <SelectableListSection
        title="Templates"
        icon={<span>icon</span>}
        count={2}
        collapsible
        defaultCollapsed
        selectedId="daily"
        onSelect={onSelect}
      >
        <SelectableListItem id="daily" label="Daily" description="Every day" icon="D" />
        <SelectableListItem id="weekly" label="Weekly" badge={<span>built-in</span>} />
      </SelectableListSection>
    )

    expect(screen.queryByText('Daily')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Templates/ }))
    expect(screen.getByText('Every day')).toBeInTheDocument()
    expect(screen.getByText('built-in')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Weekly/ }))
    expect(onSelect).toHaveBeenCalledWith('weekly')

    rerender(
      <SelectableListSection title="Static" selectedId={null}>
        <SelectableListItem id="plain" label="Plain" />
      </SelectableListSection>
    )
    expect(screen.getByText('Plain')).toBeInTheDocument()
  })

  // The template picker hands each template's stored icon straight to the row.
  it.each(['custom:i4D0i_NKqVZr0a9eb-6B3', 'icon:StarIcon'])(
    'draws a %s icon value as an icon, not as literal text',
    (icon) => {
      render(
        <SelectableListSection title="Templates">
          <SelectableListItem id="meeting" label="Meeting" icon={icon} />
        </SelectableListSection>
      )

      expect(screen.getByRole('button', { name: /Meeting/ }).textContent).not.toContain(icon)
    }
  )

  it('throws outside a section and covers standalone selected/unselected rows', () => {
    expect(() => render(<SelectableListItem id="orphan" label="Orphan" />)).toThrow(
      'SelectableListItem must be used within a SelectableListSection'
    )

    const onClick = vi.fn()
    const { rerender } = render(
      <StandaloneSelectableItem
        label="Standalone"
        description="Click me"
        icon={<span>S</span>}
        badge={<span>badge</span>}
        isSelected
        onClick={onClick}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Standalone/ }))
    expect(onClick).toHaveBeenCalled()
    expect(screen.getByText('Click me')).toBeInTheDocument()
    expect(screen.getByText('badge')).toBeInTheDocument()

    rerender(<StandaloneSelectableItem label="Fallback icon" />)
    expect(screen.getByRole('button', { name: /Fallback icon/ })).toBeInTheDocument()
  })
})
