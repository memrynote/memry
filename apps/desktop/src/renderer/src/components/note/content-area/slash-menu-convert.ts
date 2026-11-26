/**
 * A slash row that makes a text block type changes the line it was typed on
 * instead of adding one below it. BlockNote's own rows do that only when the
 * line is empty (`insertOrUpdateBlockForSlashMenu`), so `Intro /h2` left the
 * heading as a second, empty line.
 *
 * The rows below make the Turn into menu's types (`turn-into-targets.ts`),
 * and they convert only a block of one of those types. Callout and task rows
 * already convert the caret's block themselves. Everything else (divider,
 * table, columns, math, diagram, media, view, whiteboard) is insert-only and
 * keeps BlockNote's behaviour, which is also what runs when the caret is in a
 * block Turn into does not offer, such as a table cell.
 *
 * iOS applies the same rule in `SlashMenu.swift` (`BlockCatalog.Row.convertsInPlace`).
 *
 * @module note/content-area/slash-menu-convert
 */

import { closeHistory } from '@tiptap/pm/history'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { yUndoPluginKey } from 'y-prosemirror'
import { TURN_INTO_TARGETS } from './turn-into-targets'

type BlockSpec = { type: string; props?: Record<string, unknown> }

/** The block each converting row makes, by the row's id (BlockNote's `key`). */
const CONVERTING_ROWS: Readonly<Record<string, BlockSpec>> = {
  paragraph: { type: 'paragraph' },
  heading: { type: 'heading', props: { level: 1 } },
  heading_2: { type: 'heading', props: { level: 2 } },
  heading_3: { type: 'heading', props: { level: 3 } },
  heading_4: { type: 'heading', props: { level: 4 } },
  heading_5: { type: 'heading', props: { level: 5 } },
  heading_6: { type: 'heading', props: { level: 6 } },
  bullet_list: { type: 'bulletListItem' },
  numbered_list: { type: 'numberedListItem' },
  // `/check` makes a plain checkbox; the task is one ⌘Enter away.
  check_list: { type: 'checkListItem', props: { plain: true } },
  toggle_list: { type: 'toggleListItem' },
  quote: { type: 'quote' },
  code_block: { type: 'codeBlock' }
}

const TURN_INTO_TYPES: ReadonlySet<string> = new Set(TURN_INTO_TARGETS.map((target) => target.type))

// `type` is optional so BlockNote's own `updateBlock`, which takes a partial
// block, fits this shape.
type ConvertEditor = {
  getTextCursorPosition(): { block: { id: string; type: string; content?: unknown } }
  updateBlock(block: string, update: Partial<BlockSpec>): unknown
  transact<T>(callback: (tr: Transaction) => T): T
  readonly prosemirrorState: EditorState
}

type Row = { id: string; onItemClick: () => void }

/**
 * `rows` with each converting row's click changed to turn the caret's block
 * into the row's type, keeping its text and children but not the spaces that
 * separated the text from the `/`. Undo takes back the turn alone, so the line
 * comes back as it was before the `/`, as on iOS. A row that is not in
 * the converting list, a caret in a block Turn into does not offer, or an
 * empty line (which BlockNote's own click already converts) runs the row's
 * own click.
 */
export function convertCurrentBlockOnPick<T extends Row>(editor: ConvertEditor, rows: T[]): T[] {
  return rows.map((row) => {
    const spec = CONVERTING_ROWS[row.id]
    if (!spec) return row
    return {
      ...row,
      onItemClick: () => {
        const current = editor.getTextCursorPosition().block
        const empty = Array.isArray(current.content) && current.content.length === 0
        if (empty || !TURN_INTO_TYPES.has(current.type)) return row.onItemClick()
        // The menu has removed `/query`, so the caret sits where `/` was.
        editor.transact((tr) => {
          const { $from } = tr.selection
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
          const gap = /[^\S\n]+$/.exec(before)?.[0].length ?? 0
          if (gap > 0) tr.delete($from.pos - gap, $from.pos)
        })
        // Ends the undo step that holds the typing, `/query` and the gap, in
        // whichever history the editor has: BlockNote's own, or a note's Y.Doc.
        editor.transact((tr) => closeHistory(tr))
        yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager.stopCapturing()
        editor.updateBlock(current.id, spec)
      }
    }
  })
}
