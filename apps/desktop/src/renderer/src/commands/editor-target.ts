import { useEffect, useSyncExternalStore } from 'react'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { getActiveContext } from './store'

/**
 * The part of a BlockNote editor the editor commands drive. Method syntax keeps
 * BlockNote's narrower block types assignable.
 */
export interface EditorHandle {
  toggleStyles(styles: Record<string, unknown>): void
  getTextCursorPosition(): { block: unknown } | undefined
  updateBlock(ref: unknown, update: { type: string; props?: Record<string, unknown> }): void
  insertBlocks(blocks: unknown[], ref: unknown, placement: 'after'): void
  undo(): boolean
  redo(): boolean
  focus(): void
  setTextCursorPosition(block: string, placement: 'start' | 'end'): void
  insertInlineContent(content: string[]): void
  readonly domElement?: HTMLElement
}

interface Entry {
  readonly editor: EditorHandle
  /** Registration order; breaks ties between editors that were never focused. */
  readonly order: number
  focusedAt: number
}

/** Editors outside any tab (tests) register here and never resolve for a command. */
const NO_TAB = ''

/**
 * Editable editors by the tab they render in. A tab can hold several (the
 * journal shows one per day), so the target of a command is the one the user
 * focused last, and the most recently mounted one until they focus any.
 */
const entries = new Map<string, Set<Entry>>()
const listeners = new Set<() => void>()
let clock = 0

function rank(entry: Entry): [number, number] {
  return [entry.focusedAt, entry.order]
}

function newest(candidates: Iterable<Entry>): Entry | undefined {
  let best: Entry | undefined
  for (const entry of candidates) {
    if (!best) best = entry
    else {
      const [bestFocus, bestOrder] = rank(best)
      const [focus, order] = rank(entry)
      if (focus > bestFocus || (focus === bestFocus && order > bestOrder)) best = entry
    }
  }
  return best
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  for (const tabEntries of entries.values()) {
    for (const entry of tabEntries) {
      if (entry.editor.domElement?.contains(target)) entry.focusedAt = ++clock
    }
  }
}

/** The editor `tabId` would act on: last focused, else last mounted. */
export function getEditorTarget(tabId: string | null): EditorHandle | undefined {
  if (tabId === null) return undefined
  return newest(entries.get(tabId) ?? [])?.editor
}

/** The editor that currently holds `element`, in any tab. Undo and redo follow focus, not the active tab. */
export function findEditorContaining(element: Element | null): EditorHandle | undefined {
  if (!element) return undefined
  for (const tabEntries of entries.values()) {
    for (const entry of tabEntries) {
      if (entry.editor.domElement?.contains(element)) return entry.editor
    }
  }
  return undefined
}

function registerEditor(tabId: string, editor: EditorHandle): () => void {
  let tabEntries = entries.get(tabId)
  if (!tabEntries) {
    tabEntries = new Set()
    entries.set(tabId, tabEntries)
  }
  if (entries.size === 1 && tabEntries.size === 0) {
    document.addEventListener('focusin', onFocusIn, true)
  }
  const entry: Entry = { editor, order: ++clock, focusedAt: 0 }
  tabEntries.add(entry)
  notify()

  return () => {
    tabEntries.delete(entry)
    if (tabEntries.size === 0 && entries.get(tabId) === tabEntries) entries.delete(tabId)
    if (entries.size === 0) document.removeEventListener('focusin', onFocusIn, true)
    notify()
  }
}

/**
 * Register the editable editor of this subtree as an editor-command target for
 * the tab it renders in. Read-only editors (template preview) pass `null`.
 */
export function useEditorTarget(editor: EditorHandle | null): void {
  const tabId = useTabIdentity()?.tabId ?? NO_TAB

  useEffect(() => {
    if (!editor) return
    return registerEditor(tabId, editor)
  }, [editor, tabId])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether `tabId` holds an editor a format or insert command could act on. */
export function useHasEditorTarget(tabId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => getEditorTarget(tabId) !== undefined)
}

/**
 * E2E instrumentation: the editor of the active tab, else the newest mounted
 * one anywhere. Nothing in the app reads it; commands go through
 * `getEditorTarget`.
 */
Object.defineProperty(window, '__memryActiveEditor', {
  configurable: true,
  get: () =>
    getEditorTarget(getActiveContext().activeTabId) ??
    newest([...entries.values()].flatMap((tabEntries) => [...tabEntries]))?.editor
})
