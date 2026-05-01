import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { SidebarProvider, useSidebar } from './sidebar'

function SidebarStateProbe(): React.JSX.Element {
  const { state } = useSidebar()
  return <div data-testid="sidebar-state">{state}</div>
}

function sidebarToggleShortcutInit(): KeyboardEventInit {
  return isMac ? { metaKey: true } : { ctrlKey: true }
}

describe('SidebarProvider shortcuts', () => {
  beforeEach(() => {
    document.cookie = 'sidebar_state=; path=/; max-age=0'
    localStorage.clear()
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
})
