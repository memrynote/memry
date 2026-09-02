import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
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

const renderNav = () =>
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

const realApi = window.api

type SettingsListener = (event: { key: string; value: unknown }) => void

function stubNavApi(
  options: { collapsed?: boolean; save?: { success: boolean; error?: string } } = {}
) {
  const loaded = Promise.resolve(options.collapsed ?? false)
  const getSidebarNavCollapsed = vi.fn(() => loaded)
  const setSidebarNavCollapsed = vi.fn(() => Promise.resolve(options.save ?? { success: true }))
  const listeners: SettingsListener[] = []

  window.api = {
    ...realApi,
    settings: { ...realApi.settings, getSidebarNavCollapsed, setSidebarNavCollapsed },
    onSettingsChanged: vi.fn((listener: SettingsListener) => {
      listeners.push(listener)
      return () => {}
    })
  }

  return {
    getSidebarNavCollapsed,
    setSidebarNavCollapsed,
    // The stored value lands after the first paint and overwrites whatever the
    // nav is showing, so a click that races it is undone by a value nobody asked for.
    settle: async () => {
      await waitFor(() => expect(getSidebarNavCollapsed).toHaveBeenCalled())
      await act(async () => {
        await loaded
      })
    },
    emit: (event: { key: string; value: unknown }) => {
      act(() => {
        for (const listener of listeners) listener(event)
      })
    }
  }
}

const toggle = () => screen.getByTestId('sidebar-nav-toggle')
const navItems = () => screen.getByTestId('sidebar-nav-items')

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

  describe('nav collapse', () => {
    afterEach(() => {
      window.api = realApi
    })

    it('folds the nav away and opens it again', async () => {
      const api = stubNavApi()
      const user = userEvent.setup()
      renderNav()
      await api.settle()

      expect(toggle()).toHaveAttribute('aria-expanded', 'true')
      expect(navItems()).toHaveAttribute('aria-hidden', 'false')

      await user.click(toggle())

      expect(toggle()).toHaveAttribute('aria-expanded', 'false')
      expect(navItems()).toHaveAttribute('aria-hidden', 'true')
      expect(api.setSidebarNavCollapsed).toHaveBeenLastCalledWith(true)

      await user.click(toggle())

      expect(toggle()).toHaveAttribute('aria-expanded', 'true')
      expect(navItems()).toHaveAttribute('aria-hidden', 'false')
      expect(api.setSidebarNavCollapsed).toHaveBeenLastCalledWith(false)
    })

    it('renders collapsed from the stored flag alone', async () => {
      const api = stubNavApi({ collapsed: true })
      const { unmount } = renderNav()
      await api.settle()
      expect(toggle()).toHaveAttribute('aria-expanded', 'false')

      unmount()
      renderNav()
      await api.settle()

      expect(toggle()).toHaveAttribute('aria-expanded', 'false')
      expect(api.setSidebarNavCollapsed).not.toHaveBeenCalled()
    })

    it('follows a settings change from another device', async () => {
      const api = stubNavApi()
      renderNav()
      await api.settle()

      api.emit({ key: 'sidebar.navCollapsed', value: true })
      expect(toggle()).toHaveAttribute('aria-expanded', 'false')

      // The merge that reopens the nav, and the one a truthy guard would drop.
      api.emit({ key: 'sidebar.navCollapsed', value: false })
      expect(toggle()).toHaveAttribute('aria-expanded', 'true')

      api.emit({ key: 'sidebar.sectionOrder', value: true })
      expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    })

    it('folds and unfolds from the keyboard', async () => {
      const api = stubNavApi()
      renderNav()
      await api.settle()

      fireEvent.keyDown(toggle(), { key: 'ArrowLeft' })

      expect(toggle()).toHaveAttribute('aria-expanded', 'false')
      expect(api.setSidebarNavCollapsed).toHaveBeenLastCalledWith(true)

      fireEvent.keyDown(toggle(), { key: 'ArrowRight' })

      expect(toggle()).toHaveAttribute('aria-expanded', 'true')
      expect(api.setSidebarNavCollapsed).toHaveBeenLastCalledWith(false)
    })

    it('ignores the arrow that points the way the nav already is', async () => {
      const api = stubNavApi()
      renderNav()
      await api.settle()

      // Unfolding an unfolded nav is not a change, so it must not cost a write
      // that another device would then have to merge.
      fireEvent.keyDown(toggle(), { key: 'ArrowRight' })
      fireEvent.keyDown(toggle(), { key: 'End' })

      expect(toggle()).toHaveAttribute('aria-expanded', 'true')
      expect(api.setSidebarNavCollapsed).not.toHaveBeenCalled()

      fireEvent.keyDown(toggle(), { key: 'ArrowLeft' })
      fireEvent.keyDown(toggle(), { key: 'ArrowLeft' })

      expect(toggle()).toHaveAttribute('aria-expanded', 'false')
      expect(api.setSidebarNavCollapsed).toHaveBeenCalledTimes(1)
    })

    it('takes the folded rows out of the tab order', async () => {
      const api = stubNavApi()
      const user = userEvent.setup()
      renderNav()
      await api.settle()

      expect(navItems()).toHaveAttribute('aria-hidden', 'false')
      expect(navItems().hasAttribute('inert')).toBe(false)

      await user.click(toggle())

      // `aria-hidden` on its own would leave every nav row focusable inside a
      // zero-height container: tabbable, invisible, and denied to a reader.
      expect(navItems()).toHaveAttribute('aria-hidden', 'true')
      expect(navItems().hasAttribute('inert')).toBe(true)
    })

    it('puts the nav back when the save fails', async () => {
      const api = stubNavApi({ save: { success: false, error: 'Vault is read-only' } })
      const user = userEvent.setup()
      renderNav()
      await api.settle()

      await user.click(toggle())

      await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'true'))
      expect(navItems()).toHaveAttribute('aria-hidden', 'false')
    })
  })
})
