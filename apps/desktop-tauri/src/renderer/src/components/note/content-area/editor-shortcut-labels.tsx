import { useCallback } from 'react'
import type { Dictionary } from '@blocknote/core'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor
} from '@blocknote/react'
import type { Transaction } from '@tiptap/pm/state'
import { getShortcutBinding } from '@/lib/shortcut-bindings'
import { editorKeyBinding, formatBinding, type ShortcutId } from '@/lib/shortcut-catalog'

const fromRegistry = (id: ShortcutId): string => formatBinding(getShortcutBinding(id))
const fromSpec = (spec: string): string => formatBinding(editorKeyBinding(spec))

/**
 * BlockNote's dictionary with its formatting toolbar shortcuts in Memry's
 * format (#3510). BlockNote's `formatKeyboardShortcut` only swaps Mod for ⌘, so
 * strikethrough read "⌘+Shift+S" on macOS. It leaves a label without Mod alone.
 * The text styles read the command registry, which also gives code its ⌘E.
 */
export function withShortcutLabels<D extends Dictionary>(dictionary: D): D {
  const toolbar = dictionary.formatting_toolbar
  return {
    ...dictionary,
    formatting_toolbar: {
      ...toolbar,
      bold: { ...toolbar.bold, secondary_tooltip: fromRegistry('editor.bold') },
      italic: { ...toolbar.italic, secondary_tooltip: fromRegistry('editor.italic') },
      underline: { ...toolbar.underline, secondary_tooltip: fromRegistry('editor.underline') },
      strike: { ...toolbar.strike, secondary_tooltip: fromRegistry('editor.strikethrough') },
      code: { ...toolbar.code, secondary_tooltip: fromRegistry('editor.code') },
      link: { ...toolbar.link, secondary_tooltip: fromSpec(toolbar.link.secondary_tooltip) },
      nest: { ...toolbar.nest, secondary_tooltip: fromSpec(toolbar.nest.secondary_tooltip) },
      unnest: { ...toolbar.unnest, secondary_tooltip: fromSpec(toolbar.unnest.secondary_tooltip) }
    }
  }
}

/** BlockNote's slash menu items, their badges ("⌘-Alt-1" on macOS) as Memry's keycaps. */
export function withShortcutBadges<T extends { badge?: string }>(items: T[]): T[] {
  return items.map((item) =>
    item.badge ? { ...item, badge: formatBinding(editorKeyBinding(item.badge)) } : item
  )
}

// BlockNote's own default: no slash menu inside a table cell.
const outsideTable = (tr: Transaction): boolean =>
  !tr.selection.$from.parent.type.isInGroup('tableContent')

/** BlockNote's stock slash menu with Memry's keycaps. Mount inside `<BlockNoteView slashMenu={false}>`. */
export function StockSlashMenuController() {
  const editor = useBlockNoteEditor()
  const getItems = useCallback(
    async (query: string) =>
      filterSuggestionItems(withShortcutBadges(getDefaultReactSlashMenuItems(editor)), query),
    [editor]
  )
  return (
    <SuggestionMenuController triggerCharacter="/" shouldOpen={outsideTable} getItems={getItems} />
  )
}
