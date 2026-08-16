import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar
} from './sidebar'

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

  afterEach(() => {
    act(() => {
      __setShortcutOverridesForTests({})
    })
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

  it('leaves Meta/Ctrl+B to the editor while the caret is in rich text', () => {
    render(
      <SidebarProvider defaultOpen>
        <SidebarStateProbe />
        <div
          data-testid="rich-text"
          contentEditable="true"
          suppressContentEditableWarning
          tabIndex={-1}
        />
      </SidebarProvider>
    )

    const editor = screen.getByTestId('rich-text')
    editor.focus()

    fireEvent.keyDown(window, { key: 'b', ...sidebarToggleShortcutInit() })

    // Bold owns the chord here — the sidebar must not move too.
    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('expanded')

    editor.blur()
    fireEvent.keyDown(window, { key: 'b', ...sidebarToggleShortcutInit() })

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('collapsed')
  })

  it('toggles on a rebound chord and ignores the replaced one', () => {
    __setShortcutOverridesForTests({
      'view.toggleSidebar': { key: 'b', modifiers: { alt: true } }
    })

    render(
      <SidebarProvider defaultOpen>
        <SidebarStateProbe />
      </SidebarProvider>
    )

    fireEvent.keyDown(window, { key: 'b', ...sidebarToggleShortcutInit() })

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('expanded')

    fireEvent.keyDown(window, { key: 'b', altKey: true })

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('collapsed')
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
    expect(screen.getByTestId('sidebar-width')).toHaveTextContent('171')

    fireEvent.mouseUp(document)
  })

  it('renders the exported desktop sidebar building blocks', () => {
    const { container } = render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar side="right" variant="floating" collapsible="icon">
          <SidebarHeader>
            <SidebarInput aria-label="Search" />
          </SidebarHeader>
          <SidebarSeparator />
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel asChild>
                <span>Group</span>
              </SidebarGroupLabel>
              <SidebarGroupAction asChild aria-label="Add">
                <button type="button">+</button>
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton tooltip="Open notes" isActive size="lg" variant="outline">
                      <span>Notes</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction showOnHover aria-label="More" />
                    <SidebarMenuBadge>2</SidebarMenuBadge>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton href="#sub" size="sm" isActive>
                        Sub
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>Inset</SidebarInset>
        <SidebarTrigger aria-label="Toggle" />
      </SidebarProvider>
    )

    expect(container.querySelector('[data-slot="sidebar-input"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="sidebar-separator"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="sidebar-menu-badge"]')).toHaveTextContent('2')
    expect(container.querySelector('[data-slot="sidebar-menu-skeleton"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="sidebar-menu-sub-button"]')).toHaveTextContent(
      'Sub'
    )
    expect(container.querySelector('[data-slot="sidebar-inset"]')).toHaveTextContent('Inset')

    fireEvent.click(screen.getByLabelText('Toggle'))
    expect(container.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      'data-state',
      'expanded'
    )
  })

  it('throws when useSidebar is read outside a provider', () => {
    expect(() => render(<SidebarStateProbe />)).toThrow(
      'useSidebar must be used within a SidebarProvider.'
    )
  })
})
