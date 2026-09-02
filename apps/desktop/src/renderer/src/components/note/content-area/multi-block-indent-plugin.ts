/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tab / Shift+Tab over a selection that spans more than one block.
 *
 * BlockNote 0.47.1's `KeyboardShortcutsExtension` gives Tab back to the browser
 * whenever the formatting toolbar store holds a selection, which it does for any
 * non-empty selection even though this app never renders that toolbar. So the
 * multi-block case reached no indent handler at all, while a caret still nested
 * through BlockNote's own path. This plugin owns only the multi-block case and
 * leaves the caret alone.
 */

import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { liftListItem } from '@tiptap/pm/schema-list'
import type { EditorView } from '@tiptap/pm/view'
import { indentTaskBlock, outdentTaskBlock } from './hooks/task-block-marquee-indent'
import { createLogger } from '@/lib/logger'

const log = createLogger('MultiBlockIndent')

export const multiBlockIndentPluginKey = new PluginKey('multiBlockIndent')

type IndentDirection = 'indent' | 'outdent'

export function selectedBlockIds(editor: any): string[] {
  try {
    return (editor?.getSelection()?.blocks ?? []).map((block: any) => block.id)
  } catch {
    // BlockNote throws rather than returning undefined on some selections.
    return []
  }
}

function containerPos(doc: any, id: string): number | null {
  let found: number | null = null
  doc.descendants((node: any, pos: number) => {
    if (found !== null) return false
    if (node.type.name === 'blockContainer' && node.attrs?.id === id) {
      found = pos
      return false
    }
    return true
  })
  return found
}

function moveOne(editor: any, tr: Transaction, id: string, direction: IndentDirection): boolean {
  const pos = containerPos(tr.doc, id)
  if (pos === null) return false

  if (editor.getBlock(id)?.type === 'taskBlock') {
    const outcome =
      direction === 'indent' ? indentTaskBlock(editor, id) : outdentTaskBlock(editor, id)
    if (outcome.kind === 'skipped') {
      log.debug('task block not moved', id, direction, outcome.reason)
      return false
    }
    return true
  }

  tr.setSelection(NodeSelection.create(tr.doc, pos))

  if (direction === 'indent') {
    if (!editor.canNestBlock()) return false
    editor.nestBlock()
    return true
  }

  if (!editor.canUnnestBlock()) return false
  // Not `editor.unnestBlock()`: that dispatches its own tiptap command
  // transaction, which cannot join the one in flight. `liftListItem` reads only
  // `selection` and `tr` and dispatches the same `tr` back.
  const schema = tr.doc.type.schema
  return liftListItem(schema.nodes.blockContainer)({ selection: tr.selection, tr } as any, () => {})
}

function moveBlocks(editor: any, ids: readonly string[], direction: IndentDirection): boolean {
  if (ids.length === 0) return false

  let moved = 0
  editor.transact((tr: Transaction) => {
    const original = tr.selection
    const ordered = direction === 'indent' ? ids : [...ids].reverse()
    for (const id of ordered) {
      if (moveOne(editor, tr, id, direction)) moved += 1
    }
    tr.setSelection(original.map(tr.doc, tr.mapping))
  })
  return moved > 0
}

export function indentBlocks(editor: any, ids: readonly string[]): boolean {
  return moveBlocks(editor, ids, 'indent')
}

export function outdentBlocks(editor: any, ids: readonly string[]): boolean {
  return moveBlocks(editor, ids, 'outdent')
}

export function createMultiBlockIndentPlugin(editor: any): Plugin {
  return new Plugin({
    key: multiBlockIndentPluginKey,
    props: {
      handleKeyDown(_view: EditorView, event: KeyboardEvent): boolean {
        if (event.key !== 'Tab') return false
        if (event.metaKey || event.ctrlKey || event.altKey) return false

        const ids = selectedBlockIds(editor)
        if (ids.length < 2) return false

        if (event.shiftKey) outdentBlocks(editor, ids)
        else indentBlocks(editor, ids)
        // Consumed even when nothing moved, or the browser moves focus out.
        return true
      }
    }
  })
}
