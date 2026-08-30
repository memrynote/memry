import { act, fireEvent, render, screen } from '@testing-library/react'
import { type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { TabProvider, useActiveGroupTabs, useActiveTab } from '@/contexts/tabs'
import type { Tab, TabSystemState } from '@/contexts/tabs'
import { useTemplateDraft } from '@/hooks/use-template-draft'
import { UpdateReleaseNotesTabOpener } from './update-release-notes-tab-opener'

const mocks = vi.hoisted(() => ({
  state: {} as AppUpdateState,
  updateTemplate: vi.fn()
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({ state: mocks.state })
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    createTemplate: vi.fn(),
    updateTemplate: mocks.updateTemplate
  })
}))

const quiet: AppUpdateState = {
  currentVersion: '2026.700.1',
  status: 'up-to-date',
  updateSupported: true,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  releaseNotesHtml: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoDownloadEnabled: false,
  autoCheckEnabled: true
}

/**
 * A silent auto-download, which is the path the reporting customer was on: an
 * update surfaces with no prompt to click through.
 */
const downloading = (version: string): AppUpdateState => ({
  ...quiet,
  status: 'downloading',
  availableVersion: version,
  releaseNotes: 'notes',
  releaseNotesHtml: `<p>${version}</p>`
})

const templateTab: Tab = {
  id: 'template-tab',
  type: 'template-editor',
  title: 'Weekly Review',
  icon: 'file-text',
  path: '/templates/tpl-1',
  entityId: 'tpl-1',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1
}

const initialState = (): TabSystemState => ({
  tabGroups: {
    g1: {
      id: 'g1',
      tabs: [templateTab],
      activeTabId: templateTab.id,
      isActive: true,
      back: [],
      forward: []
    }
  },
  layout: { type: 'leaf', tabGroupId: 'g1' },
  activeGroupId: 'g1',
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
  recentlyClosed: []
})

/**
 * The real template draft: body edits live in component state behind an 800ms
 * debounce whose cleanup clears the pending save without flushing it, so an
 * unmount inside that window discards everything typed since the last write.
 */
function TemplateEditorStub(): ReactElement {
  const { fields, setFields } = useTemplateDraft({
    templateId: 'tpl-1',
    initial: { name: 'Weekly Review', icon: null, tags: [], properties: [], content: '' }
  })
  return (
    <textarea
      aria-label="template body"
      value={fields.content}
      onChange={(event) => setFields({ content: event.target.value })}
    />
  )
}

/** Mirrors `TabPane`, which mounts the active tab's content and nothing else. */
function ActivePane(): ReactElement | null {
  const activeTab = useActiveTab()
  return activeTab?.type === 'template-editor' ? <TemplateEditorStub /> : null
}

function TabStrip(): ReactElement {
  const tabs = useActiveGroupTabs()
  const activeTab = useActiveTab()
  return (
    <ul>
      {tabs.map((tab) => (
        <li key={tab.id} data-testid={`tab-${tab.type}`} aria-current={tab.id === activeTab?.id}>
          {tab.title}
        </li>
      ))}
    </ul>
  )
}

describe('release-notes tab focus', () => {
  let state: TabSystemState

  // A fresh element every time: React bails out of reconciling a re-render whose
  // element is referentially identical, which would stop the opener from ever
  // seeing the new updater state.
  const tree = (): ReactElement => (
    <TabProvider initialState={state}>
      <UpdateReleaseNotesTabOpener />
      <TabStrip />
      <ActivePane />
    </TabProvider>
  )

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.updateTemplate.mockReset()
    mocks.updateTemplate.mockResolvedValue({ id: 'tpl-1' })
    mocks.state = quiet
    state = initialState()
    window.api.onSettingsChanged = vi.fn(() => vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves the tab the user is working in active when an update surfaces', () => {
    const { rerender } = render(tree())
    expect(screen.getByTestId('tab-template-editor')).toHaveAttribute('aria-current', 'true')

    mocks.state = downloading('2026.708.1')
    rerender(tree())

    expect(screen.getByTestId('tab-virtual-note')).toHaveAttribute('aria-current', 'false')
    expect(screen.getByTestId('tab-template-editor')).toHaveAttribute('aria-current', 'true')
  })

  it('lets the debounced template save land instead of unmounting it away', () => {
    const { rerender } = render(tree())
    fireEvent.change(screen.getByLabelText('template body'), {
      target: { value: '## Wins\n## Blockers' }
    })

    // Mid-debounce: the edit is still only in the mounted component.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(mocks.updateTemplate).not.toHaveBeenCalled()

    mocks.state = downloading('2026.708.1')
    rerender(tree())
    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mocks.updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tpl-1', content: '## Wins\n## Blockers' })
    )
    expect(screen.getByLabelText('template body')).toHaveValue('## Wins\n## Blockers')
  })
})
