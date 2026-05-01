import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from './sidebar'

function SidebarStateProbe(): React.JSX.Element {
  const { state } = useSidebar()
  return <div data-testid="sidebar-state">{state}</div>
}

function SidebarWidthProbe(): React.JSX.Element {
  const { sidebarWidth } = useSidebar()
  return <div data-testid="sidebar-width">{sidebarWidth}</div>
}

function sidebarToggleShortcutInit(): KeyboardEventInit {
  return isMac ? { metaKey: true } : { ctrlKey: true }
}

function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width
  })
}

describe('SidebarProvider shortcuts', () => {
  beforeEach(() => {
    document.cookie = 'sidebar_state=; path=/; max-age=0'
    localStorage.clear()
    setWindowWidth(1024)
  })

  it('toggles the desktop sidebar with Meta/Ctrl+B', () => {
    render(
      <SidebarProvider defaultOpen>
        <SidebarStateProbe />
      </SidebarProvider>
    )

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('expanded')

    fireEvent.keyDown(window, { key: 'b', ...sidebarToggleShortcutInit() })

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('collapsed')

    fireEvent.keyDown(window, { key: 'b', ...sidebarToggleShortcutInit() })

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('expanded')
  })

  it('collapses the desktop sidebar when a resize drag passes below the minimum width', () => {
    const { container } = render(
      <SidebarProvider defaultOpen>
        <Sidebar side="left">
          <SidebarRail />
        </Sidebar>
        <SidebarStateProbe />
        <SidebarWidthProbe />
      </SidebarProvider>
    )

    const rail = container.querySelector<HTMLButtonElement>('[data-sidebar="rail"]')
    expect(rail).not.toBeNull()

    fireEvent.mouseDown(rail!, { clientX: 256 })
    fireEvent.mouseMove(document, { clientX: 10 })

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('collapsed')
    expect(screen.getByTestId('sidebar-width')).toHaveTextContent('244')

    fireEvent.mouseUp(document)
  })
})
