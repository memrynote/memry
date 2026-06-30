import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarSection } from '@/components/sidebar-section'
import { SplitPane } from '@/components/split-view/split-pane'
import { SRAnnouncer } from '@/components/sr-announcer'
import { announceToScreenReader } from '@/components/sr-announcer-queue'
import { calculateGroupPositions, findGroupInDirection, getGroupOrder } from './use-pane-navigation'
import { useNoteEditorSettings } from './use-note-editor-settings'
import { usePages } from './use-pages'
import { useRevealInSidebar } from './use-reveal-in-sidebar'
import { useTaskSettings } from './use-task-settings'

const sidebarState = vi.hoisted(() => ({ value: 'expanded' }))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <section className={className}>{children}</section>
  ),
  SidebarMenu: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  useSidebar: () => ({ state: sidebarState.value })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  })
}))

describe('cold renderer support surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sidebarState.value = 'expanded'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('calculates split-pane group positions, directions, and order', () => {
    const layout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.6,
      first: { type: 'leaf', tabGroupId: 'left' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.25,
        first: { type: 'leaf', tabGroupId: 'top-right' },
        second: { type: 'leaf', tabGroupId: 'bottom-right' }
      }
    } as const

    const positions = calculateGroupPositions(layout)

    expect(positions.left).toEqual({ centerX: 0.3, centerY: 0.5 })
    expect(positions['top-right']).toEqual({ centerX: 0.8, centerY: 0.125 })
    expect(findGroupInDirection('left', 'right', positions)).toBe('top-right')
    expect(findGroupInDirection('top-right', 'down', positions)).toBe('left')
    expect(findGroupInDirection('missing', 'left', positions)).toBeNull()
    expect(getGroupOrder(layout)).toEqual(['top-right', 'left', 'bottom-right'])
  })

  it('reveals sidebar items by path or entity, expands sections, scrolls, and auto-clears highlight', () => {
    vi.useFakeTimers()
    const expandSection = vi.fn()
    const scrollIntoView = vi.fn()
    const element = document.createElement('div')
    element.setAttribute('data-item-id', 'note-1')
    element.scrollIntoView = scrollIntoView
    document.body.append(element)

    const items = [
      {
        id: 'project-1',
        type: 'project',
        path: '/projects/work',
        entityId: 'work'
      },
      {
        id: 'folder-1',
        type: 'collection',
        path: '/folders/research',
        children: [
          {
            id: 'note-1',
            type: 'note',
            path: '/notes/research.md',
            entityId: 'note-entity'
          }
        ]
      }
    ] as any[]

    const { result, unmount } = renderHook(() => useRevealInSidebar(items, expandSection))

    expect(result.current.findItem('/missing')).toBeNull()
    expect(result.current.findItem('/unused', 'note-entity')?.id).toBe('note-1')

    act(() => {
      window.dispatchEvent(
        new CustomEvent('reveal-in-sidebar', {
          detail: { path: '/notes/research.md' }
        })
      )
    })

    expect(expandSection).toHaveBeenCalledWith('notes')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(result.current.highlightedItemId).toBe('note-1')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current.highlightedItemId).toBeNull()

    act(() => {
      result.current.setHighlightedItemId('manual')
      result.current.setHighlightedItemId('other')
      vi.advanceTimersByTime(2000)
    })
    expect(result.current.highlightedItemId).toBeNull()

    unmount()
    element.remove()
  })

  it('loads, updates, and resets local task settings', () => {
    localStorage.setItem(
      'memry-task-settings',
      JSON.stringify({ subtasks: { inheritDueDate: true } })
    )

    const { result } = renderHook(() => useTaskSettings())

    expect(result.current.subtaskSettings).toEqual(
      expect.objectContaining({
        autoCompleteParent: true,
        inheritDueDate: true,
        showProgressBar: true
      })
    )

    act(() => {
      result.current.updateSubtaskSettings({ inheritPriority: true, showProgressBar: false })
    })
    expect(result.current.subtaskSettings.inheritPriority).toBe(true)
    expect(localStorage.getItem('memry-task-settings')).toContain('"showProgressBar":false')

    act(() => {
      result.current.resetToDefaults()
    })
    expect(result.current.subtaskSettings).toEqual(
      expect.objectContaining({ inheritDueDate: false, showProgressBar: true })
    )
  })

  it('falls back when local task settings storage is invalid or unavailable', () => {
    localStorage.setItem('memry-task-settings', '{bad json')
    const { result, unmount } = renderHook(() => useTaskSettings())
    expect(result.current.subtaskSettings.autoCompleteParent).toBe(true)
    unmount()

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const fallback = renderHook(() => useTaskSettings())
    act(() => {
      fallback.result.current.updateSubtaskSettings({ inheritDueDate: true })
    })
    expect(fallback.result.current.subtaskSettings.inheritDueDate).toBe(true)
  })

  it('loads pages from storage, mutates them, and searches recent pages', () => {
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('new-page-id')
    localStorage.setItem(
      'memry:pages',
      JSON.stringify([
        {
          id: 'old',
          title: 'Old Page',
          type: 'page',
          lastEdited: '2026-05-01T00:00:00.000Z',
          exists: true
        }
      ])
    )

    const { result } = renderHook(() => usePages())

    expect(result.current.checkPageExists(' old page ')).toBe(true)
    expect(result.current.getPageByTitle('OLD PAGE')?.id).toBe('old')
    expect(result.current.searchPages('').map((page) => page.id)).toEqual(['old'])

    let createdId = ''
    act(() => {
      createdId = result.current.createPage(' New Page ', 'journal').id
    })
    expect(createdId).toBe('new-page-id')
    expect(result.current.checkPageExists('New Page')).toBe(true)

    act(() => {
      result.current.updatePage('new-page-id', { title: 'Renamed Page' })
    })
    expect(result.current.getPageByTitle('Renamed Page')).toBeDefined()
    expect(result.current.searchPages('renamed')[0]?.id).toBe('new-page-id')
    expect(result.current.getRecentPages(1)[0]?.id).toBe('new-page-id')

    act(() => {
      result.current.deletePage('new-page-id')
    })
    expect(result.current.checkPageExists('Renamed Page')).toBe(false)
  })

  it('uses mock pages and logs through invalid page storage', () => {
    localStorage.setItem('memry:pages', '{bad json')
    const { result } = renderHook(() => usePages())
    expect(result.current.pages.length).toBeGreaterThan(1)

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    act(() => {
      result.current.createPage('Stored Later')
    })
    expect(result.current.checkPageExists('Stored Later')).toBe(true)
  })

  it('loads note editor settings, handles change events, and updates optimistically', async () => {
    const getSettings = vi.fn().mockResolvedValue({ toolbarMode: 'sticky' })
    const setSettings = vi.fn().mockResolvedValue({ success: true })
    const unsubscribe = vi.fn()
    let listener: ((event: { key: string; value: unknown }) => void) | null = null

    const api = (window as any).api
    api.settings.getNoteEditorSettings = getSettings
    api.settings.setNoteEditorSettings = setSettings
    api.onSettingsChanged = vi.fn((callback) => {
      listener = callback
      return unsubscribe
    })

    const { result, unmount } = renderHook(() => useNoteEditorSettings())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.settings.toolbarMode).toBe('sticky')

    act(() => {
      listener?.({ key: 'noteEditor', value: { toolbarMode: 'floating' } })
    })
    expect(result.current.settings.toolbarMode).toBe('floating')

    let success = false
    await act(async () => {
      success = await result.current.setToolbarMode('sticky')
    })
    expect(success).toBe(true)
    expect(result.current.settings.toolbarMode).toBe('sticky')

    act(() => {
      listener?.({ key: 'general', value: { toolbarMode: 'floating' } })
    })
    expect(result.current.settings.toolbarMode).toBe('sticky')

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('surfaces note editor load and update failures', async () => {
    const api = (window as any).api
    api.settings.getNoteEditorSettings = vi.fn().mockRejectedValue(new Error('load failed'))
    api.settings.setNoteEditorSettings = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'save failed' })
      .mockRejectedValueOnce(new Error('boom'))
    api.onSettingsChanged = vi.fn(() => vi.fn())

    const { result } = renderHook(() => useNoteEditorSettings())
    await waitFor(() => expect(result.current.error).toBe('load failed'))

    await act(async () => {
      expect(await result.current.setToolbarMode('sticky')).toBe(false)
    })
    expect(result.current.error).toBe('save failed')

    await act(async () => {
      expect(await result.current.setToolbarMode('floating')).toBe(false)
    })
    expect(result.current.error).toBe('boom')
  })

  it('renders sidebar sections with persisted expansion, keyboard control, and collapsed state', () => {
    const { rerender } = render(
      <SidebarSection id="notes" label="Notes" totalCount={2} actions={<button>add</button>}>
        <div>child item</div>
      </SidebarSection>
    )

    const button = screen.getByRole('button', { name: 'Notes section, expanded, 2 items' })
    expect(screen.getByText('child item')).toBeInTheDocument()
    expect(screen.getByText('add')).toBeInTheDocument()

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(localStorage.getItem('sidebar-section-notes-expanded')).toBe('false')
    expect(screen.getByText('(2)')).toBeInTheDocument()

    fireEvent.keyDown(button, { key: 'ArrowRight' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(button, { key: 'ArrowLeft' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(button, { key: ' ' })
    expect(button).toHaveAttribute('aria-expanded', 'false')

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'sidebar-section-notes-expanded',
          newValue: 'true'
        })
      )
    })
    expect(button).toHaveAttribute('aria-expanded', 'true')

    sidebarState.value = 'collapsed'
    rerender(
      <SidebarSection id="notes" label="Notes">
        <div>hidden item</div>
      </SidebarSection>
    )
    expect(screen.queryByText('hidden item')).not.toBeInTheDocument()
  })

  it('resizes split panes horizontally and vertically with min-size clamping', () => {
    const onResize = vi.fn()
    const { rerender } = render(
      <SplitPane direction="horizontal" ratio={0.25} onResize={onResize} minSize={100}>
        {['first pane', 'second pane']}
      </SplitPane>
    )
    const pane = screen.getByTestId('split-pane')
    pane.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }) as DOMRect

    fireEvent.mouseDown(screen.getByRole('separator'))
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.mouseMove(document, { clientX: 320 })
    fireEvent.mouseUp(document)
    expect(onResize).toHaveBeenCalledWith(0.75)
    expect(document.body.style.cursor).toBe('')

    onResize.mockClear()
    rerender(
      <SplitPane direction="vertical" ratio={0.5} onResize={onResize} minSize={100}>
        {['top pane', 'bottom pane']}
      </SplitPane>
    )
    screen.getByTestId('split-pane').getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400 }) as DOMRect

    fireEvent.mouseDown(screen.getByRole('separator'))
    expect(document.body.style.cursor).toBe('row-resize')
    fireEvent.mouseMove(document, { clientY: 20 })
    fireEvent.mouseUp(document)
    expect(onResize).toHaveBeenCalledWith(0.25)
  })

  it('queues and announces screen-reader messages', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })

    announceToScreenReader('queued message')
    const { unmount } = render(<SRAnnouncer className="sr-only-test" />)
    const status = screen.getByRole('status')

    expect(status).toHaveTextContent('queued message')

    act(() => {
      announceToScreenReader('live message')
    })
    expect(status).toHaveTextContent('live message')

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(status).toHaveTextContent('')

    unmount()
    announceToScreenReader('queued after unmount')
    render(<SRAnnouncer />)
    expect(screen.getByRole('status')).toHaveTextContent('queued after unmount')
  })
})
