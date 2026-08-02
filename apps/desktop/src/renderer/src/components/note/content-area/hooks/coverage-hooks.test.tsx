import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePasteLinkMenu } from './use-paste-link-menu'
import { useTagSuggestions } from './use-tag-suggestions'
import { useFolderSuggestions, clearFolderSuggestionsCache } from '@/hooks/use-folder-suggestions'
import { usePropertySection } from '@/hooks/use-property-section'

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  createHashTagInlinePlugin: vi.fn((getTagColor: (tag: string) => string) => ({
    spec: { key: 'hash-tag-inline-plugin' },
    getTagColor
  })),
  useProperties: vi.fn(),
  ensurePropertyDefinition: vi.fn(),
  logError: vi.fn()
}))

vi.mock('../hash-tag-inline-plugin', () => ({
  createHashTagInlinePlugin: mocks.createHashTagInlinePlugin
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))

vi.mock('@/hooks/use-properties', () => ({
  useProperties: mocks.useProperties
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { ensurePropertyDefinition: mocks.ensurePropertyDefinition }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

function refFor(container: HTMLDivElement) {
  return { current: container }
}

function paste(container: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: vi.fn(() => text) }
  })
  container.dispatchEvent(event)
}

function makeContainer() {
  const container = document.createElement('div')
  container.getBoundingClientRect = vi.fn(
    () => ({ left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 }) as DOMRect
  )
  document.body.append(container)
  return container
}

describe('coverage hooks around note editing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearFolderSuggestionsCache()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('opens paste-link options for URLs and drives keyboard, click-away, and direct selection paths', () => {
    const container = makeContainer()
    const onSelect = vi.fn()
    const range = {
      getBoundingClientRect: vi.fn(
        () => ({ left: 40, top: 50, right: 90, bottom: 70, width: 50, height: 20 }) as DOMRect
      )
    }

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      getRangeAt: vi.fn(() => range)
    } as unknown as Selection)

    const { result } = renderHook(() =>
      usePasteLinkMenu({ editorContainerRef: refFor(container), onSelect })
    )

    act(() => paste(container, 'not a url'))
    expect(result.current.state.isOpen).toBe(false)

    act(() => paste(container, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
    expect(result.current.state).toMatchObject({
      isOpen: true,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      position: { x: 30, y: 54 },
      options: ['mention', 'embed', 'bookmark', 'url'],
      selectedIndex: 0
    })

    act(() => {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(result.current.state.selectedIndex).toBe(1)

    act(() => {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('embed', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(result.current.state.isOpen).toBe(false)

    act(() => paste(container, 'https://memry.test/page'))
    expect(result.current.state.options).toEqual(['mention', 'bookmark', 'url'])

    act(() => result.current.handleSelect('url'))
    expect(onSelect).toHaveBeenLastCalledWith('url', 'https://memry.test/page')
    expect(result.current.state.isOpen).toBe(false)

    act(() => paste(container, 'https://memry.test/second'))
    const menu = document.createElement('button')
    menu.dataset.pasteLinkMenu = 'true'
    document.body.append(menu)
    act(() => menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(result.current.state.isOpen).toBe(true)

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(result.current.state.isOpen).toBe(false)

    act(() => paste(container, 'https://memry.test/escape'))
    act(() => {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(result.current.state.isOpen).toBe(false)
  })

  it('registers tag plugins, recolors hash nodes, handles pill clicks, and replaces suggestions', () => {
    const container = makeContainer()
    const tr = {
      setNodeMarkup: vi.fn(() => tr),
      replaceWith: vi.fn(() => tr)
    }
    const hashTagNodeType = { create: vi.fn((attrs) => ({ type: { name: 'hashTag' }, attrs })) }
    const oldNode = { type: { name: 'hashTag' }, nodeSize: 4 }
    const tiptap = {
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      state: {
        tr,
        schema: { nodes: { hashTag: hashTagNodeType } },
        doc: {
          descendants: vi.fn((visitor: (node: unknown, pos: number) => void) => {
            visitor({ type: { name: 'hashTag' }, attrs: { tag: 'work', color: 'stone' } }, 4)
            visitor({ type: { name: 'text' }, attrs: {} }, 8)
          }),
          nodeAt: vi.fn(() => oldNode)
        }
      },
      view: { dispatch: vi.fn() }
    }
    const editor = { _tiptapEditor: tiptap }

    const { result, rerender, unmount } = renderHook(
      ({ tagColorMap }) =>
        useTagSuggestions({ editor, editorContainerRef: refFor(container), tagColorMap }),
      { initialProps: { tagColorMap: new Map([['work', 'blue']]) } }
    )

    expect(mocks.createHashTagInlinePlugin).toHaveBeenCalled()
    expect(tiptap.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ spec: { key: 'hash-tag-inline-plugin' } })
    )
    expect(result.current.getTagColor('work')).toBe('blue')
    expect(tiptap.view.dispatch).toHaveBeenCalledWith(tr)
    expect(tr.setNodeMarkup).toHaveBeenCalledWith(4, undefined, {
      tag: 'work',
      color: 'blue',
      icon: ''
    })

    rerender({ tagColorMap: new Map([['work', 'green']]) })
    expect(result.current.getTagColor('work')).toBe('green')

    const pill = document.createElement('span')
    pill.className = 'inline-hash-tag'
    pill.dataset.hashTag = 'work'
    pill.dataset.hashTagColor = 'green'
    container.append(pill)
    act(() => pill.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tag', entityId: 'work', color: 'green' })
    )

    act(() => result.current.handleTagSuggestionSelect('workflow', 'purple', 12))
    expect(hashTagNodeType.create).toHaveBeenCalledWith({
      tag: 'workflow',
      color: 'purple',
      icon: ''
    })
    expect(tr.replaceWith).toHaveBeenCalledWith(12, 16, {
      type: { name: 'hashTag' },
      attrs: { tag: 'workflow', color: 'purple', icon: '' }
    })
    expect(tiptap.view.dispatch).toHaveBeenLastCalledWith(tr)

    unmount()
    expect(tiptap.unregisterPlugin).toHaveBeenCalledWith('hash-tag-inline-plugin')
  })

  it('maps and mutates property sections, including blocked actions and persistence errors', async () => {
    const updateProperty = vi.fn().mockResolvedValue(undefined)
    const addProperty = vi.fn().mockResolvedValue(undefined)
    const removeProperty = vi.fn().mockResolvedValue(undefined)
    const renameProperty = vi.fn().mockResolvedValue(undefined)
    const reorderProperties = vi.fn().mockResolvedValue(undefined)
    mocks.useProperties.mockReturnValue({
      properties: [{ name: 'Status', type: 'text', value: 'Draft' }],
      updateProperty,
      addProperty,
      removeProperty,
      renameProperty,
      reorderProperties
    })

    const canEdit = vi.fn(() => true)
    const onBlocked = vi.fn()
    const onError = vi.fn()
    const { result, rerender } = renderHook(
      ({ allow }) =>
        usePropertySection({
          entityId: 'note-1',
          canEdit: () => allow,
          onBlocked,
          onError,
          includeExplicitType: true
        }),
      { initialProps: { allow: true } }
    )

    expect(result.current.properties).toEqual([
      { id: 'Status', name: 'Status', type: 'text', value: 'Draft', isCustom: true }
    ])

    act(() => result.current.handlePropertyChange('Status', 'Done'))
    await waitFor(() => expect(updateProperty).toHaveBeenCalledWith('Status', 'Done'))

    await act(async () => {
      result.current.handleAddProperty({ name: 'Status', type: 'status' })
      await vi.dynamicImportSettled()
    })
    await waitFor(() =>
      expect(mocks.ensurePropertyDefinition).toHaveBeenCalledWith('Status', 'status')
    )
    await waitFor(() => expect(addProperty).toHaveBeenCalledWith('Status', null, 'status'))
    await waitFor(() => expect(result.current.newlyAddedPropertyId).toBe('Status 2'))

    act(() => vi.advanceTimersByTime(2000))
    expect(result.current.newlyAddedPropertyId).toBeNull()

    act(() => result.current.handleDeleteProperty('Status'))
    act(() => result.current.handlePropertyNameChange('Status', 'Stage'))
    act(() => result.current.handlePropertyOrderChange(['Stage']))
    await waitFor(() => expect(removeProperty).toHaveBeenCalledWith('Status'))
    await waitFor(() => expect(renameProperty).toHaveBeenCalledWith('Status', 'Stage'))
    await waitFor(() => expect(reorderProperties).toHaveBeenCalledWith(['Stage']))

    rerender({ allow: false })
    act(() => result.current.handlePropertyChange('Status', 'Blocked'))
    expect(onBlocked).toHaveBeenCalledWith('update')
    expect(updateProperty).toHaveBeenCalledTimes(1)

    updateProperty.mockRejectedValueOnce(new Error('write failed'))
    rerender({ allow: true })
    act(() => result.current.handlePropertyChange('Status', 'Error'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('update', expect.any(Error)))
  })

  it('fetches, caches, refetches, and reports folder suggestions', async () => {
    const api = window.api as typeof window.api & {
      folderView: { getFolderSuggestions: ReturnType<typeof vi.fn> }
    }
    api.folderView = {
      getFolderSuggestions: vi.fn().mockResolvedValue({
        suggestions: [{ path: 'Work', reason: 'Recent related notes', confidence: 0.9 }]
      })
    }

    const { result, rerender, unmount } = renderHook(({ noteId }) => useFolderSuggestions(noteId), {
      initialProps: { noteId: 'note-1' as string | null }
    })

    act(() => vi.runOnlyPendingTimers())
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(api.folderView.getFolderSuggestions).toHaveBeenCalledTimes(1)

    rerender({ noteId: null })
    act(() => vi.runOnlyPendingTimers())
    await waitFor(() => expect(result.current.suggestions).toEqual([]))

    rerender({ noteId: 'note-1' })
    act(() => vi.runOnlyPendingTimers())
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    expect(api.folderView.getFolderSuggestions).toHaveBeenCalledTimes(1)

    api.folderView.getFolderSuggestions.mockRejectedValueOnce(new Error('offline'))
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.error).toEqual(expect.any(Error)))
    expect(result.current.suggestions).toEqual([])
    expect(mocks.logError).toHaveBeenCalledWith('Error fetching suggestions:', expect.any(Error))

    unmount()
  })
})
