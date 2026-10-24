import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectTabBar } from './project-tab-bar'

const base = {
  active: 'all' as const,
  onChange: vi.fn(),
  counts: { all: 3, tasks: 2, notes: 1, files: 0, events: 0 },
  showDone: false,
  onShowDoneChange: vi.fn(),
  railOpen: false,
  onToggleRail: vi.fn(),
  onEdit: vi.fn(),
  onArchive: vi.fn(),
  canArchive: true
}

describe('ProjectTabBar', () => {
  it('hides the tabs of empty categories and keeps Overview and All', () => {
    render(<ProjectTabBar {...base} />)
    const names = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(names).toEqual(['Overview', 'All3', 'Tasks2', 'Notes1'])
  })

  it('keeps the active tab even when its category is empty', () => {
    render(<ProjectTabBar {...base} active="files" />)
    expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('offers Show done in the more menu on the All tab only', async () => {
    const onShowDoneChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<ProjectTabBar {...base} onShowDoneChange={onShowDoneChange} />)

    const buttons = screen.getAllByRole('button')
    await user.click(buttons[buttons.length - 1])
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /show done/i }))
    expect(onShowDoneChange).toHaveBeenCalledWith(true)

    rerender(<ProjectTabBar {...base} active="tasks" onShowDoneChange={onShowDoneChange} />)
    const again = screen.getAllByRole('button')
    await user.click(again[again.length - 1])
    expect(await screen.findByRole('menuitem', { name: /edit project/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: /show done/i })).not.toBeInTheDocument()
  })
})
