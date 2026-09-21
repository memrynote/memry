import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { GroupHeader } from './group-header'

const renderHeader = (props: Partial<React.ComponentProps<typeof GroupHeader>> = {}) =>
  render(
    <GroupHeader
      label="Acme / Legal"
      count={3}
      sortField="folder"
      groupKey="folder-Acme/Legal"
      {...props}
    />
  )

describe('GroupHeader', () => {
  it('should announce the group, its count and whether it is collapsed', () => {
    // #given
    renderHeader({ isCollapsed: true })

    // #then
    expect(
      screen.getByRole('button', { name: 'Acme / Legal, 3 tasks, collapsed' })
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('should call back when toggled', async () => {
    // #given
    const onToggle = vi.fn()
    renderHeader({ onToggle })

    // #when
    screen.getByRole('button').click()

    // #then
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['folder' as const, 'folder-Acme/Legal'],
    ['note' as const, 'note-note-1'],
    ['dueDate' as const, 'today'],
    ['createdAt' as const, 'today']
  ])('should render one leading icon for the %s grouping', (sortField, groupKey) => {
    // #when
    const { container } = renderHeader({ sortField, groupKey, label: 'Group', color: '#3b82f6' })

    // #then the chevron plus exactly one mode icon
    expect(container.querySelectorAll('svg')).toHaveLength(2)
  })

  it('should mark an urgent priority group with the star and the rest with bars', () => {
    // #given the star is the only unlabelled priority marker; the bars carry one
    const urgent = renderHeader({
      sortField: 'priority',
      groupKey: 'urgent',
      label: 'Urgent',
      color: '#ef4444'
    })

    // #then
    expect(screen.queryByLabelText('urgent priority')).toBeNull()
    expect(urgent.container.querySelector('svg path[fill="#ef4444"]')).toBeInTheDocument()
    urgent.unmount()

    // #when
    renderHeader({ sortField: 'priority', groupKey: 'high', label: 'High' })

    // #then
    expect(screen.getByLabelText('high priority')).toBeInTheDocument()
  })

  it('should show the project swatch only when the project has a color', () => {
    // #given
    const { container, rerender } = render(
      <GroupHeader label="Work" count={1} sortField="project" groupKey="p1" color="#6366f1" />
    )

    // #then
    expect(container.querySelector('div[style*="background-color"]')).toBeInTheDocument()

    // #when the project carries no color
    rerender(<GroupHeader label="Work" count={1} sortField="project" groupKey="p1" />)

    // #then
    expect(container.querySelector('div[style*="background-color"]')).toBeNull()
  })
})
