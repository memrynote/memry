import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppRail, type AppRailItem } from './app-rail'
import type { SidebarItem } from '@/contexts/tabs/types'

vi.mock('@/components/sidebar/open-target-menu-items', () => ({
  OpenTargetMenuItems: () => null
}))

const icon = (): React.JSX.Element => <svg data-testid="rail-icon" />

const items: AppRailItem[] = [
  { title: 'Home', page: 'home', icon },
  { title: 'Inbox', page: 'inbox', icon },
  { title: 'Tasks', page: 'tasks', icon }
]

function renderRail(overrides: Partial<React.ComponentProps<typeof AppRail>> = {}) {
  const onNavClick = vi.fn()
  render(
    <TooltipProvider>
      <AppRail
        items={items}
        isActive={(item: SidebarItem) => item.type === 'home'}
        onNavClick={(page) => () => onNavClick(page)}
        onNavMiddleClick={() => () => {}}
        isModifierHeld={false}
        inboxCount={3}
        todayTasksCount={12}
        onOpenJournalSettings={() => {}}
        dock={<button type="button">Settings</button>}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { onNavClick }
}

describe('AppRail', () => {
  it('names every page, marks the active one, and opens a page on click', () => {
    const { onNavClick } = renderRail()

    const home = screen.getByRole('button', { name: 'Home' })
    expect(home).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /Inbox/ })).not.toHaveAttribute('aria-current')

    fireEvent.click(screen.getByTestId('rail-tasks'))
    expect(onNavClick).toHaveBeenCalledWith('tasks')
  })

  it('shows inbox and today counts, capped at 9+', () => {
    renderRail()

    expect(screen.getByTestId('rail-badge-inbox')).toHaveTextContent('3')
    expect(screen.getByTestId('rail-badge-tasks')).toHaveTextContent('9+')
    expect(screen.queryByTestId('rail-badge-home')).not.toBeInTheDocument()
  })

  it('swaps icons for their shortcut numbers while the modifier is held', () => {
    renderRail({ isModifierHeld: true })

    expect(within(screen.getByTestId('rail-home')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTestId('rail-tasks')).getByText('3')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-icon')).not.toBeInTheDocument()
  })

  it('pins the dock to the rail foot', () => {
    renderRail()

    expect(
      within(screen.getByTestId('app-rail-dock')).getByRole('button', { name: 'Settings' })
    ).toBeInTheDocument()
  })
})
