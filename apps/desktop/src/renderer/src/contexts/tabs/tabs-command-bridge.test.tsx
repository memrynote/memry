import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCommandStoreForTests } from '@/commands/store'
import { useCommandDispatcher } from '@/commands'
import { hintModeActiveRef } from '@/contexts/hint-mode'
import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'
import { setShortcutRecording } from '@/hooks/use-keyboard-shortcuts-base'
import { TabProvider, useTabs } from '@/contexts/tabs'
import { registerNewTabMenu } from './new-tab-menu-opener'
import { TabsCommandBridge } from './tabs-command-bridge'
import type { Tab, TabGroup, TabSystemState } from './types'

const windowClose = vi.fn()

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

const makeState = (tabs: Tab[] = [makeTab()]): TabSystemState => {
  const group: TabGroup = {
    id: 'main',
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    isActive: true,
    back: [],
    forward: []
  }
  return {
    tabGroups: { main: group },
    layout: { type: 'leaf', tabGroupId: group.id },
    activeGroupId: group.id,
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
    recentlyClosed: []
  }
}

let latest: TabSystemState

const Harness = (): null => {
  const { state } = useTabs()
  useCommandDispatcher()
  useEffect(() => {
    latest = state
  }, [state])
  return null
}

function mount(initialState: TabSystemState): void {
  latest = initialState
  render(
    <TabProvider initialState={initialState}>
      <TabsCommandBridge />
      <Harness />
    </TabProvider>
  )
}

/** Off macOS ⌘ is Ctrl. Returns false when the listener consumed the key. */
const press = (init: KeyboardEventInit, target: Element | Window = window): boolean =>
  fireEvent.keyDown(target, init)

const activeGroup = (): TabGroup => latest.tabGroups[latest.activeGroupId]

beforeEach(() => {
  resetCommandStoreForTests()
  ;(window as unknown as { api: unknown }).api = {
    onSettingsChanged: vi.fn(() => vi.fn()),
    windowClose
  }
})

afterEach(() => {
  // The dispatcher subscribes to overrides, so resetting them re-renders it.
  act(() => {
    __setShortcutOverridesForTests({})
  })
  setShortcutRecording(false)
  hintModeActiveRef.current = false
  windowClose.mockClear()
})

describe('tab commands from the keyboard', () => {
  it.each([
    ['⌘\\ splits right', { key: '\\', code: 'Backslash', ctrlKey: true }, 'horizontal'],
    [
      '⌘⇧\\ splits down on the real keystroke, which reports |',
      { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true },
      'vertical'
    ]
  ])('%s', async (_name, init, direction) => {
    mount(makeState())

    expect(press(init)).toBe(false)

    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
      if (latest.layout.type !== 'split') throw new Error('expected a split layout')
      expect(latest.layout.direction).toBe(direction)
    })
  })

  it('duplicates the active tab into a second tab on the same entity', async () => {
    mount(makeState())

    press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      const group = activeGroup()
      expect(group.tabs).toHaveLength(2)
      expect(group.tabs[0].entityId).toBe(group.tabs[1].entityId)
      expect(group.activeTabId).toBe(group.tabs[1].id)
      expect(group.tabs[1].isPinned).toBe(false)
    })
  })

  it('pins and unpins the active tab', async () => {
    mount(makeState())

    press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(activeGroup().tabs[0].isPinned).toBe(true)
    })

    press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(activeGroup().tabs[0].isPinned).toBe(false)
    })
  })

  it('closes the active tab, and cycles tabs with Ctrl+Tab', async () => {
    const first = makeTab()
    const second = makeTab()
    mount(makeState([first, second]))

    press({ key: 'Tab', ctrlKey: true })
    await waitFor(() => {
      expect(activeGroup().activeTabId).toBe(second.id)
    })

    press({ key: 'w', code: 'KeyW', ctrlKey: true })
    await waitFor(() => {
      expect(activeGroup().tabs.map((t) => t.id)).toEqual([first.id])
    })
    expect(windowClose).not.toHaveBeenCalled()
  })

  it('opens the new-tab menu of the active group', async () => {
    mount(makeState())
    const open = vi.fn()
    const other = vi.fn()
    registerNewTabMenu('main', open)
    registerNewTabMenu('elsewhere', other)

    expect(press({ key: 't', code: 'KeyT', ctrlKey: true })).toBe(false)

    expect(open).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })
})

describe('closing the last tab', () => {
  const home = (): Tab => makeTab({ type: 'home', title: 'Home', entityId: undefined })

  it('closes the window instead of the lone Home tab', async () => {
    mount(makeState([home()]))

    press({ key: 'w', code: 'KeyW', ctrlKey: true })

    expect(windowClose).toHaveBeenCalledTimes(1)
    expect(activeGroup().tabs).toHaveLength(1)
  })

  it.each(['inbox', 'calendar', 'tasks'] as const)(
    'closes a lone %s tab, not the window',
    async (type) => {
      mount(makeState([makeTab({ type, title: type, entityId: undefined })]))

      press({ key: 'w', code: 'KeyW', ctrlKey: true })

      expect(windowClose).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(activeGroup().tabs.every((t) => t.type !== type)).toBe(true)
      })
    }
  )

  it('closes Home like any tab while a sibling is open', async () => {
    const siblingHome = home()
    mount(makeState([siblingHome, makeTab()]))

    press({ key: 'w', code: 'KeyW', ctrlKey: true })

    expect(windowClose).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(activeGroup().tabs.some((t) => t.id === siblingHome.id)).toBe(false)
    })
  })

  it('collapses the split instead of closing the window on a lone Home tab', async () => {
    mount(makeState([home()]))
    press({ key: '\\', code: 'Backslash', ctrlKey: true })
    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
    })

    press({ key: 'w', code: 'KeyW', ctrlKey: true })

    expect(windowClose).not.toHaveBeenCalled()
  })
})

describe('close split', () => {
  it('passes ⌘⌥W through while there is no split, then closes the split', async () => {
    mount(makeState())
    const closeSplit = { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }

    expect(press(closeSplit)).toBe(true)

    press({ key: '\\', code: 'Backslash', ctrlKey: true })
    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
    })

    expect(press(closeSplit)).toBe(false)
    await waitFor(() => {
      expect(latest.layout.type).toBe('leaf')
    })
  })
})

describe('when a tab chord must not fire', () => {
  it('passes the keys through when the group has no tab to act on', async () => {
    mount(makeState([]))

    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true })).toBe(true)
    expect(press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(windowClose).not.toHaveBeenCalled()
  })

  it('stands down while Settings records a shortcut', async () => {
    mount(makeState())

    setShortcutRecording(true)
    expect(press({ key: '\\', code: 'Backslash', ctrlKey: true })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest.layout.type).toBe('leaf')

    setShortcutRecording(false)
    press({ key: '\\', code: 'Backslash', ctrlKey: true })
    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
    })
  })

  it('leaves the key untouched while hint mode holds the keyboard', async () => {
    mount(makeState())
    hintModeActiveRef.current = true

    expect(press({ key: '\\', code: 'Backslash', ctrlKey: true })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest.layout.type).toBe('leaf')
  })
})

describe('typing and rebinding', () => {
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
    mount(makeState())
    const field = create()
    document.body.appendChild(field)
    field.focus()

    press({ key: '\\', code: 'Backslash', ctrlKey: true }, field)

    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
    })
    field.remove()
  })

  it('follows a rebind from Settings and frees the default chord', async () => {
    __setShortcutOverridesForTests({
      'tabs.splitRight': { key: 'y', modifiers: { meta: true, alt: true } }
    })
    mount(makeState())

    expect(press({ key: '\\', code: 'Backslash', ctrlKey: true })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest.layout.type).toBe('leaf')

    act(() => {
      press({ key: 'y', code: 'KeyY', ctrlKey: true, altKey: true })
    })
    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
    })
  })

  it('keeps a rebind without ⌘/Ctrl out of text fields, where it would eat typing', async () => {
    __setShortcutOverridesForTests({ 'tabs.splitRight': { key: 'y', modifiers: {} } })
    mount(makeState())
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()

    expect(press({ key: 'y', code: 'KeyY' }, field)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest.layout.type).toBe('leaf')

    field.remove()
    press({ key: 'y', code: 'KeyY' })
    await waitFor(() => {
      expect(latest.layout.type).toBe('split')
    })
  })
})
