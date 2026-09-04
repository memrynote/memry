import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamSwitcher } from './team-switcher'
import { AutocompleteDropdown } from './ui/autocomplete-dropdown'
import { ColorPicker } from './tasks/color-picker'
import { TimePicker } from './tasks/time-picker'
import { HugeIconGrid } from './note/note-title/HugeIconGrid'
import { useHugeIconPicker } from './note/note-title/use-hugeicon-picker'
import { HugeIconByName, loadAllIcons } from '@/lib/hugeicon-renderer'
import {
  getRecentFolders,
  getSuggestedFolders,
  sampleFolders,
  UNSORTED_FOLDER_ID
} from '@/data/filing-data'
import { SelectedFolderProvider, useSelectedFolder } from '@/contexts/selected-folder-context'

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  scrollToIndex: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/icons', () => {
  const Icon = ({ className }: { className?: string }) => <span className={className}>icon</span>
  return {
    Check: Icon,
    ChevronsUpDown: Icon,
    Clock: Icon,
    LayoutGrid: Icon,
    Loader: Icon,
    LogOut: Icon,
    Moon: Icon,
    Plus: Icon,
    Settings: Icon,
    X: Icon
  }
})

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: ({ icon, className }: { icon: unknown; className?: string }) => (
    <span className={className}>huge:{String(icon)}</span>
  )
}))

vi.mock('@hugeicons/core-free-icons', () => ({
  AlphaIcon: 'alpha-icon',
  BetaTestIcon: 'beta-icon',
  Calendar2Icon: 'calendar-icon',
  CircleIcon: 'circle-icon',
  lowercaseIcon: 'ignored-icon'
}))

vi.mock('@/lib/icons/hugeicons-subset', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CircleIcon: 'circle-icon'
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    scrollToIndex: mocks.scrollToIndex,
    getTotalSize: () => 40,
    getVirtualItems: () => [{ index: 0, start: 0 }]
  })
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: mocks.setTheme })
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSidebar: () => ({ isMobile: false })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, onSelect, ...props }: any) => (
    <button
      type="button"
      onClick={(event) => {
        onSelect?.(event)
        onClick?.(event)
      }}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  SelectValue: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, onClick }: any) => (
    <span
      role="switch"
      aria-pressed={checked}
      onClick={(event) => {
        onClick?.(event)
        onCheckedChange?.(!checked)
      }}
    >
      switch
    </span>
  )
}))

const Logo = () => <span>logo</span>

function SelectedFolderProbe() {
  const { selectedFolder, setSelectedFolder } = useSelectedFolder()
  return (
    <button type="button" onClick={() => setSelectedFolder('Work')}>
      selected:{selectedFolder || 'empty'}
    </button>
  )
}

describe('more zero-covered renderer surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('loads huge icons by name, filters picker data, and renders the virtual grid', async () => {
    await expect(loadAllIcons()).resolves.toHaveProperty('AlphaIcon')

    render(<HugeIconByName name="AlphaIcon" className="icon-class" />)
    expect(screen.getByText('huge:circle-icon')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('huge:alpha-icon')).toBeInTheDocument())

    const { result } = renderHook(() => useHugeIconPicker())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.icons.map((icon) => icon.name)).toEqual([
      'AlphaIcon',
      'BetaTestIcon',
      'Calendar2Icon',
      'CircleIcon'
    ])

    act(() => result.current.setSearch('beta test'))
    expect(result.current.icons.map((icon) => icon.name)).toEqual(['BetaTestIcon'])

    const onSelect = vi.fn()
    render(<HugeIconGrid onSelect={onSelect} />)
    await waitFor(() => expect(screen.getByDisplayValue('')).toBeInTheDocument())
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calendar 2' } })
    await waitFor(() => expect(mocks.scrollToIndex).toHaveBeenCalledWith(0))
    fireEvent.click(screen.getByTitle('Calendar2'))
    expect(onSelect).toHaveBeenCalledWith('Calendar2Icon')
  })

  it('drives time and color pickers', () => {
    const onTimeChange = vi.fn()
    const onColorChange = vi.fn()
    const { rerender } = render(<TimePicker value={null} onChange={onTimeChange} />)
    const timeInput = screen.getByLabelText('phaseF.componentsTasksTimePicker.selectTime')
    expect(timeInput).toHaveValue('')

    // Native input accepts any minute, not just :00/:30
    fireEvent.change(timeInput, { target: { value: '12:22' } })
    expect(onTimeChange).toHaveBeenCalledWith('12:22')

    rerender(<TimePicker value="13:30" onChange={onTimeChange} />)
    expect(screen.getByLabelText('phaseF.componentsTasksTimePicker.selectTime')).toHaveValue(
      '13:30'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'phaseF.componentsTasksTimePicker.clearTime' })
    )
    expect(onTimeChange).toHaveBeenCalledWith(null)

    render(
      <ColorPicker
        value="#111111"
        onChange={onColorChange}
        colors={[
          { id: 'black', value: '#111111', label: 'Black' },
          { id: 'red', value: '#ff0000', label: 'Red' }
        ]}
        size="sm"
      />
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Black' }), { key: 'Enter' })
    expect(onColorChange).toHaveBeenCalledWith('#ff0000')
    expect(onColorChange).toHaveBeenCalledWith('#111111')
  })

  it('renders autocomplete suggestions and selected-folder context', () => {
    const onSelect = vi.fn()
    const { rerender, container } = render(
      <AutocompleteDropdown suggestions={[]} selectedIndex={0} onSelect={onSelect} visible />
    )
    expect(container).toBeEmptyDOMElement()

    rerender(
      <AutocompleteDropdown
        visible
        selectedIndex={1}
        onSelect={onSelect}
        suggestions={[
          { label: 'title', type: 'variable' },
          { label: 'sum', type: 'function', signature: '(a, b)' }
        ]}
      />
    )
    expect(screen.getByRole('listbox')).toHaveAccessibleName(
      'phaseF.componentsUiAutocompleteDropdown.suggestions'
    )
    fireEvent.click(screen.getByText('sum'))
    expect(onSelect).toHaveBeenCalledWith(1)

    expect(() => renderHook(() => useSelectedFolder())).toThrow(
      'useSelectedFolder must be used within SelectedFolderProvider'
    )
    render(
      <SelectedFolderProvider>
        <SelectedFolderProbe />
      </SelectedFolderProvider>
    )
    fireEvent.click(screen.getByText('selected:empty'))
    expect(screen.getByText('selected:Work')).toBeInTheDocument()
  })

  it('exposes filing sample groups and renders the team switcher menu actions', () => {
    expect(UNSORTED_FOLDER_ID).toBe('unsorted')
    expect(sampleFolders.some((folder) => folder.id === UNSORTED_FOLDER_ID)).toBe(true)
    expect(getSuggestedFolders().map((folder) => folder.id)).toEqual(['1', '2', '3'])
    expect(getRecentFolders().map((folder) => folder.id)).toEqual(['4', '5'])

    render(
      <TeamSwitcher
        teams={[
          { name: 'memrynote', logo: Logo },
          { name: 'Personal', logo: Logo }
        ]}
      />
    )
    expect(screen.getAllByText('memrynote')[0]).toBeInTheDocument()
    fireEvent.click(screen.getByText('Personal'))
    expect(screen.getAllByText('Personal')[0]).toBeInTheDocument()
    fireEvent.click(screen.getByText('switch'))
    expect(mocks.setTheme).toHaveBeenCalledWith('dark')
    expect(screen.getByText('phaseF.componentsTeamSwitcher.newWorkspace')).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsTeamSwitcher.signOut')).toBeInTheDocument()
  })
})
