import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibleTab } from '@/components/tabs/accessible-tab'
import { NewTabMenu } from '@/components/tabs/new-tab-menu'
import { PinnedTab } from '@/components/tabs/pinned-tab'
import { RegularTab } from '@/components/tabs/regular-tab'
import { TabIcon } from '@/components/tabs/tab-icon'
import type { Tab } from '@/contexts/tabs/types'
import { notesService } from '@/services/notes-service'

const tabsApi = {
  setActiveTab: vi.fn(),
  closeTab: vi.fn(),
  openTab: vi.fn(),
  dispatch: vi.fn(),
  state: {
    activeGroupId: 'group-1',
    tabGroups: {
      'group-1': {
        id: 'group-1',
        activeTabId: 'tab-1',
        tabs: [] as Tab[]
      }
    }
  }
}

const settings = {
  tabCloseButton: 'active'
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { create: vi.fn() }
}))

vi.mock('@/contexts/selected-folder-context', () => ({
  useSelectedFolder: () => ({ selectedFolder: 'Work' })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { createInSelectedFolder: true } })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => tabsApi,
  useTabSettings: () => settings,
  useTabGroup: (groupId: string) => tabsApi.state.tabGroups[groupId as 'group-1']
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value }: { value: string }) => <span>{value}</span>
}))

const makeTab = (overrides: Partial<Tab> = {}): Tab =>
  ({
    id: 'tab-1',
    type: 'note',
    title: 'Daily Note',
    path: '/note/tab-1',
    icon: 'file-text',
    emoji: null,
    entityId: 'tab-1',
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false,
    lastAccessedAt: Date.now(),
    ...overrides
  }) as Tab

describe('tabs components coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tabsApi.state.tabGroups['group-1'].tabs = [
      makeTab({ id: 'tab-1', title: 'Daily Note' }),
      makeTab({ id: 'tab-2', title: 'Inbox', type: 'inbox', isPinned: true, isModified: true })
    ]
  })

  it('renders icon variants including emoji and fallback', () => {
    const { container, rerender } = render(<TabIcon type="note" icon="file-text" />)
    expect(container.querySelector('svg')).toBeInTheDocument()

    rerender(<TabIcon type="note" emoji="📝" />)
    expect(screen.getByText('📝')).toBeInTheDocument()

    rerender(<TabIcon type="file" icon="unknown-icon" />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('activates and closes regular tabs', () => {
    const tab = makeTab({ isModified: true, isPreview: false })
    render(<RegularTab tab={tab} groupId="group-1" isActive />)

    fireEvent.click(screen.getByRole('tab', { name: /Daily Note/ }))
    fireEvent.doubleClick(screen.getByRole('tab', { name: /Daily Note/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Daily Note' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Daily Note/ }), { button: 1 })

    expect(tabsApi.setActiveTab).toHaveBeenCalledWith('tab-1', 'group-1')
    expect(tabsApi.closeTab).toHaveBeenCalledWith('tab-1', 'group-1')
  })

  it('activates and middle-click closes pinned tabs', () => {
    const tab = makeTab({
      id: 'pin-1',
      title: 'Pinned',
      type: 'calendar',
      isPinned: true,
      isModified: true
    })
    render(<PinnedTab tab={tab} groupId="group-1" isActive={false} />)

    fireEvent.click(screen.getByRole('tab'))
    fireEvent.mouseDown(screen.getByRole('tab'), { button: 1 })

    expect(tabsApi.setActiveTab).toHaveBeenCalledWith('pin-1', 'group-1')
    expect(tabsApi.closeTab).toHaveBeenCalledWith('pin-1', 'group-1')
    expect(screen.getByText('Pinned')).toBeInTheDocument()
  })

  it('covers accessible tab keyboard and close controls', () => {
    const tab = makeTab({ isModified: true, isPreview: false })
    const { rerender } = render(
      <AccessibleTab tab={tab} groupId="group-1" index={0} totalTabs={2} isActive isFocused />
    )

    fireEvent.click(screen.getByRole('tab', { name: /Daily Note/ }))
    fireEvent.keyDown(screen.getByRole('tab', { name: /Daily Note/ }), { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Close Daily Note tab' }))
    expect(tabsApi.closeTab).toHaveBeenCalledWith('tab-1', 'group-1')

    rerender(
      <AccessibleTab
        tab={makeTab({ title: 'Pinned', isPinned: true })}
        groupId="group-1"
        index={1}
        totalTabs={2}
        isActive={false}
      />
    )
    tabsApi.closeTab.mockClear()
    fireEvent.keyDown(screen.getByRole('tab', { name: /Pinned, pinned/ }), { key: 'Delete' })
    expect(tabsApi.closeTab).not.toHaveBeenCalled()
  })

  it('opens new note and app tabs from the new tab menu', async () => {
    vi.mocked(notesService.create).mockResolvedValue({
      success: true,
      note: { id: 'note-1', title: 'Untitled Note' }
    } as never)
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    render(<NewTabMenu groupId="group-1" />)

    act(() => {
      window.dispatchEvent(new Event('memry:new-tab-menu'))
    })
    fireEvent.click(screen.getByRole('option', { name: /newNote/ }))
    await waitFor(() => expect(notesService.create).toHaveBeenCalled())
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memry:expand-folder' })
    )
    expect(tabsApi.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1' }),
      { groupId: 'group-1' }
    )

    act(() => {
      window.dispatchEvent(new Event('memry:new-tab-menu'))
    })
    fireEvent.click(screen.getByRole('option', { name: /journal/ }))
    act(() => {
      window.dispatchEvent(new Event('memry:new-tab-menu'))
    })
    fireEvent.click(screen.getByRole('option', { name: /calendar/ }))
    act(() => {
      window.dispatchEvent(new Event('memry:new-tab-menu'))
    })
    fireEvent.click(screen.getByRole('option', { name: /inboxCapture/ }))
    act(() => {
      window.dispatchEvent(new Event('memry:new-tab-menu'))
    })
    fireEvent.click(screen.getByRole('option', { name: /tasks/ }))
    expect(tabsApi.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'journal' }), {
      groupId: 'group-1'
    })
    expect(tabsApi.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'calendar' }), {
      groupId: 'group-1'
    })
    expect(tabsApi.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'inbox' }), {
      groupId: 'group-1'
    })
    expect(tabsApi.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'tasks' }), {
      groupId: 'group-1'
    })
  })
})
