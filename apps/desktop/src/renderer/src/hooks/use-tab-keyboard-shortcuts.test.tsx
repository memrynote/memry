import { fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TabProvider, useTabs } from '@/contexts/tabs'
import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'
import { setShortcutRecording } from './use-keyboard-shortcuts-base'
import type { Tab, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { useTabKeyboardShortcuts } from './use-tab-keyboard-shortcuts'

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: `tab-${Math.random().toString(36).slice(2, 8)}`,
  type: 'note',
  title: 'Test Note',
  icon: 'file-text',
  path: '/note/test',
  entityId: `entity-${Math.random().toString(36).slice(2, 8)}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
  ...overrides
})

const makeGroup = (tabs: Tab[]): TabGroup => ({
  id: `group-${Math.random().toString(36).slice(2, 8)}`,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  isActive: true,
  back: [],
  forward: []
})

const makeState = (): TabSystemState => {
  const group = makeGroup([makeTab()])

  return {
    tabGroups: { [group.id]: group },
    layout: { type: 'leaf', tabGroupId: group.id },
    activeGroupId: group.id,
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
  }
}

const Harness = ({ onState }: { onState: (state: TabSystemState) => void }): null => {
  const { state } = useTabs()
  useTabKeyboardShortcuts()

  useEffect(() => {
    onState(state)
  }, [onState, state])

  return null
}

describe('useTabKeyboardShortcuts', () => {
  afterEach(() => {
    __setShortcutOverridesForTests({})
  })

  it('creates a horizontal split for Cmd+\\', async () => {
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: '\\', metaKey: true, ctrlKey: true })

    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
      if (latestState.layout.type === 'split') {
        expect(latestState.layout.direction).toBe('horizontal')
      }
    })
  })

  it('creates a vertical split for Cmd+Shift+\\', async () => {
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: '\\', metaKey: true, ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
      if (latestState.layout.type === 'split') {
        expect(latestState.layout.direction).toBe('vertical')
      }
    })
  })

  it('follows a rebind from Settings and frees the default chord', async () => {
    __setShortcutOverridesForTests({
      'tabs.splitRight': { key: 'y', modifiers: { meta: true, alt: true } }
    })
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(latestState.layout.type).toBe('leaf')

    fireEvent.keyDown(window, { key: 'y', code: 'KeyY', ctrlKey: true, altKey: true })
    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
    })
  })

  it('splits down on the real ⌘⇧\\ keystroke, which reports | as the key', async () => {
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
      if (latestState.layout.type === 'split') {
        expect(latestState.layout.direction).toBe('vertical')
      }
    })
  })

  it('duplicates the active note tab into a second tab on the same note', async () => {
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      const group = latestState.tabGroups[latestState.activeGroupId]
      expect(group.tabs).toHaveLength(2)
      expect(group.tabs[0].entityId).toBe(group.tabs[1].entityId)
      expect(group.activeTabId).toBe(group.tabs[1].id)
    })
  })

  it.each([
    [
      'the note editor',
      () => {
        const editor = document.createElement('div')
        editor.setAttribute('contenteditable', 'true')
        Object.defineProperty(editor, 'isContentEditable', { value: true })
        editor.tabIndex = 0
        return editor
      }
    ],
    ['a textarea', () => document.createElement('textarea')]
  ])('splits with the caret in %s', async (_name, create) => {
    const initialState = makeState()
    let latestState = initialState
    ;(window as unknown as { api: unknown }).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    const field = create()
    document.body.appendChild(field)
    field.focus()
    fireEvent.keyDown(field, { key: '\\', code: 'Backslash', ctrlKey: true })

    await waitFor(() => expect(latestState.layout.type).toBe('split'))
    field.remove()
  })

  it('keeps a rebind without ⌘/Ctrl out of text fields, where it would eat typing', async () => {
    __setShortcutOverridesForTests({ 'tabs.splitRight': { key: 'y', modifiers: {} } })
    const initialState = makeState()
    let latestState = initialState
    ;(window as unknown as { api: unknown }).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()
    fireEvent.keyDown(field, { key: 'y', code: 'KeyY' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(latestState.layout.type).toBe('leaf')

    field.remove()
    fireEvent.keyDown(window, { key: 'y', code: 'KeyY' })
    await waitFor(() => expect(latestState.layout.type).toBe('split'))
  })

  it('stands down while Settings records a shortcut', async () => {
    const initialState = makeState()
    let latestState = initialState
    ;(window as unknown as { api: unknown }).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    setShortcutRecording(true)
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(latestState.layout.type).toBe('leaf')

    setShortcutRecording(false)
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true })
    await waitFor(() => expect(latestState.layout.type).toBe('split'))
  })
})
