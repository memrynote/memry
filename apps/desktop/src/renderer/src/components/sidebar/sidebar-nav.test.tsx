import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SidebarNav } from './sidebar-nav'
import type { AppPage } from '@/App'

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  // Spreads the rest of its props: ContextMenuTrigger renders `asChild` and
  // clones this button with the handlers that open the menu (onContextMenu,
  // onPointerDown). A mock that keeps only `onClick` silently swallows them and
  // the context menu never opens.
  SidebarMenuButton: ({
    children,
    isActive: _isActive,
    ...props
  }: {
    children: ReactNode
    isActive?: boolean
  } & React.ComponentPropsWithoutRef<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarMenuBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

// Open in New Tab / Open to the Side reach for the tabs context, which this
// suite has no reason to stand up — they have their own test.
vi.mock('@/components/sidebar/open-target-menu-items', () => ({
  OpenTargetMenuItems: () => null
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
        onOpenJournalSettings={() => {}}
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
        onOpenJournalSettings={() => {}}
      />
    )

    // Numbers follow the given order; labels stay.
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('Inbox')).toBeTruthy()
  })

  it('offers Journal Settings on the Journal row only', async () => {
    const onOpenJournalSettings = vi.fn()
    const user = userEvent.setup()

    render(
      <SidebarNav
        items={items}
        isActive={() => false}
        onNavClick={noop}
        onNavMiddleClick={noop}
        isModifierHeld={false}
        inboxCount={0}
        todayTasksCount={0}
        onOpenJournalSettings={onOpenJournalSettings}
      />
    )

    // Radix opens on the native contextmenu event; user-event's right-click
    // pointer sequence does not dispatch one in jsdom.
    fireEvent.contextMenu(screen.getByText('Inbox'))
    expect(screen.queryByText('Journal Settings…')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(screen.getByText('Journal'))
    await user.click(await screen.findByText('Journal Settings…'))

    expect(onOpenJournalSettings).toHaveBeenCalledTimes(1)
  })
})
