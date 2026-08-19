import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SidebarNav } from './sidebar-nav'
import type { AppPage } from '@/App'

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({
    children,
    onClick
  }: {
    children: ReactNode
    onClick?: (e: never) => void
  }) => (
    <button type="button" onClick={onClick as never}>
      {children}
    </button>
  ),
  SidebarMenuBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

const Icon = () => <svg />

const items = [
  { title: 'Inbox', page: 'inbox' as AppPage, icon: Icon },
  { title: 'Journal', page: 'journal' as AppPage, icon: Icon },
  { title: 'Home', page: 'home' as AppPage, icon: Icon }
]

const noop = () => () => {}

describe('SidebarNav', () => {
  it('renders exactly the items it is given (caller pre-filters visibility)', () => {
    render(
      <SidebarNav
        items={items}
        isActive={() => false}
        onNavClick={noop}
        onNavMiddleClick={noop}
        isModifierHeld={false}
        inboxCount={0}
        todayTasksCount={0}
      />
    )

    expect(screen.getByText('Inbox')).toBeTruthy()
    expect(screen.getByText('Journal')).toBeTruthy()
    expect(screen.getByText('Home')).toBeTruthy()
  })

  it('swaps icons for 1-based shortcut numbers while the modifier is held', () => {
    render(
      <SidebarNav
        items={items}
        isActive={() => false}
        onNavClick={noop}
        onNavMiddleClick={noop}
        isModifierHeld
        inboxCount={0}
        todayTasksCount={0}
      />
    )

    // Numbers follow the given order; labels stay.
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('Inbox')).toBeTruthy()
  })
})
