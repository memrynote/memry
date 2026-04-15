import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { SidebarProvider } from '@/components/ui/sidebar'
import {
  TabProvider,
  useTabActions,
  useTabs,
  type SidebarItem,
  type Tab,
  type TabType
} from '@/contexts/tabs'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { SidebarNav } from '@/components/sidebar/sidebar-nav'
import { NewTabMenu } from '@/components/tabs/new-tab-menu'
import { TabContent } from '@/components/split-view/tab-content'
import { renderWithProviders, userEvent } from '@tests/utils/render'

vi.mock('@/contexts/selected-folder-context', () => ({
  useSelectedFolder: () => ({ selectedFolder: '', setSelectedFolder: vi.fn() })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { createInSelectedFolder: false } })
}))

vi.mock('@/pages/inbox', () => ({
  InboxPage: () => <div>Inbox</div>
}))

vi.mock('@/pages/journal', () => ({
  JournalPage: () => <div>Journal</div>
}))

vi.mock('@/pages/tasks', () => ({
  TasksPage: () => <div>Tasks</div>
}))

vi.mock('@/pages/note', () => ({
  NotePage: () => <div>Note</div>
}))

vi.mock('@/pages/file', () => ({
  FilePage: () => <div>File</div>
}))

vi.mock('@/pages/folder-view', () => ({
  FolderViewPage: () => <div>Folder</div>
}))

vi.mock('@/pages/template-editor', () => ({
  TemplateEditorPage: () => <div>Template Editor</div>
}))

vi.mock('@/pages/templates', () => ({
  TemplatesPage: () => <div>Templates</div>
}))

vi.mock('@/components/graph/graph-page', () => ({
  GraphPage: () => <div>Graph</div>
}))

const CALENDAR_ITEM: SidebarItem = {
  type: 'calendar' as TabType,
  title: 'Calendar',
  path: '/calendar'
}

const CALENDAR_TAB: Tab = {
  id: 'calendar-tab',
  type: 'calendar' as TabType,
  title: 'Calendar',
  icon: 'calendar',
  path: '/calendar',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1
}

function TabStateSummary() {
  const { state } = useTabs()
  const tabTypes = Object.values(state.tabGroups).flatMap((group) =>
    group.tabs.map((tab) => tab.type)
  )
  const calendarCount = tabTypes.filter((type) => type === 'calendar').length

  return (
    <>
      <div data-testid="active-group">{state.activeGroupId}</div>
      <div data-testid="tab-types">{tabTypes.join(',')}</div>
      <div data-testid="calendar-count">{calendarCount}</div>
    </>
  )
}

function SidebarCalendarHarness() {
  const { state } = useTabs()
  const { splitView, setActiveGroup } = useTabActions()
  const { openSidebarItem } = useSidebarNavigation()
  const primaryGroupId =
    state.layout.type === 'leaf' ? state.layout.tabGroupId : state.activeGroupId
  const secondaryGroupId = Object.keys(state.tabGroups).find(
    (groupId) => groupId !== primaryGroupId
  )

  return (
    <>
      <button type="button" onClick={() => splitView('horizontal', primaryGroupId)}>
        Split
      </button>
      <button type="button" onClick={() => setActiveGroup(primaryGroupId)}>
        Focus Primary
      </button>
      <button type="button" onClick={() => secondaryGroupId && setActiveGroup(secondaryGroupId)}>
        Focus Secondary
      </button>
      <SidebarNav
        items={[
          {
            title: 'Calendar',
            page: 'calendar' as never,
            icon: () => <span data-testid="calendar-nav-icon" />,
            shortcut: '⌘⌥3'
          }
        ]}
        isActive={() => false}
        onNavClick={() => () => openSidebarItem(CALENDAR_ITEM)}
        inboxCount={0}
        todayTasksCount={0}
      />
      <TabStateSummary />
    </>
  )
}

function NewTabMenuHarness() {
  const { state } = useTabs()

  return (
    <>
      <NewTabMenu groupId={state.activeGroupId} />
      <TabStateSummary />
    </>
  )
}

describe('Calendar workspace navigation', () => {
  beforeEach(() => {
    const api = window.api as {
      onSettingsChanged?: ReturnType<typeof vi.fn>
      onCalendarChanged?: ReturnType<typeof vi.fn>
      calendar?: {
        getRange?: ReturnType<typeof vi.fn>
        listSources?: ReturnType<typeof vi.fn>
      }
    }

    localStorage.clear()
    api.onSettingsChanged ??= vi.fn()
    api.onCalendarChanged ??= vi.fn()
    api.calendar ??= {}
    api.calendar.getRange ??= vi.fn()
    api.calendar.listSources ??= vi.fn()

    api.onSettingsChanged.mockReturnValue(() => {})
    api.onCalendarChanged.mockReturnValue(() => {})
    api.calendar.getRange.mockResolvedValue({ items: [] })
    api.calendar.listSources.mockResolvedValue({ sources: [] })
  })

  it('opens Calendar from the sidebar as a singleton across split groups', async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <SidebarProvider>
        <TabProvider>
          <SidebarCalendarHarness />
        </TabProvider>
      </SidebarProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Split' }))
    await user.click(screen.getByRole('button', { name: 'Focus Primary' }))
    await user.click(screen.getByRole('button', { name: 'Calendar' }))

    expect(screen.getByTestId('calendar-count')).toHaveTextContent('1')
    const primaryGroupId = screen.getByTestId('active-group').textContent

    await user.click(screen.getByRole('button', { name: 'Focus Secondary' }))
    await user.click(screen.getByRole('button', { name: 'Calendar' }))

    expect(screen.getByTestId('calendar-count')).toHaveTextContent('1')
    expect(screen.getByTestId('active-group')).toHaveTextContent(primaryGroupId ?? '')
  })

  it('opens Calendar from the new-tab menu', async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <TabProvider>
        <NewTabMenuHarness />
      </TabProvider>
    )

    await user.click(screen.getByRole('button', { name: 'New Tab' }))
    await user.click(screen.getByText('Calendar'))

    expect(screen.getByTestId('calendar-count')).toHaveTextContent('1')
    expect(screen.getByTestId('tab-types')).toHaveTextContent('calendar')
  })

  it('routes a calendar tab through TabContent', () => {
    renderWithProviders(
      <TabProvider>
        <TabContent tab={CALENDAR_TAB} groupId="calendar-group" />
      </TabProvider>
    )

    expect(screen.getByTestId('calendar-page')).toBeInTheDocument()
    expect(screen.queryByText(/Unknown tab type/i)).not.toBeInTheDocument()
  })
})
