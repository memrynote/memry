import type { CommandIdsOf } from '@memry/contracts/commands'
import {
  findEditorContaining,
  getEditorTarget,
  useHasEditorTarget,
  type EditorHandle
} from './editor-target'
import { getActiveContext, useAvailableCommands } from './store'
import { useAppCommands } from './use-command-impls'
import type { CommandImpl, OwnerImpls } from './types'

type EditorCommandId = CommandIdsOf<'editor'>
type HistoryCommandId = 'editor.undo' | 'editor.redo'

/**
 * What a format or insert command does to the focused editor. Block-type names
 * match the editor schema, unlike slash-menu titles, which are localized.
 */
type EditorAction =
  | { readonly kind: 'style'; readonly styles: Record<string, unknown> }
  /** Convert the current block to another type. */
  | { readonly kind: 'convert'; readonly type: string; readonly props?: Record<string, unknown> }
  /** Insert a fresh block after the current one. */
  | { readonly kind: 'insert'; readonly block: unknown }

const heading = (level: number): EditorAction => ({
  kind: 'convert',
  type: 'heading',
  props: { level }
})

export const EDITOR_ACTIONS: Record<Exclude<EditorCommandId, HistoryCommandId>, EditorAction> = {
  'editor.bold': { kind: 'style', styles: { bold: true } },
  'editor.italic': { kind: 'style', styles: { italic: true } },
  'editor.underline': { kind: 'style', styles: { underline: true } },
  'editor.strikethrough': { kind: 'style', styles: { strike: true } },
  'editor.code': { kind: 'style', styles: { code: true } },
  'editor.highlight': { kind: 'style', styles: { backgroundColor: 'yellow' } },
  'editor.heading1': heading(1),
  'editor.heading2': heading(2),
  'editor.heading3': heading(3),
  'editor.heading4': heading(4),
  'editor.heading5': heading(5),
  'editor.heading6': heading(6),
  'editor.body': { kind: 'convert', type: 'paragraph' },
  'editor.insertBulletList': { kind: 'convert', type: 'bulletListItem' },
  'editor.insertNumberedList': { kind: 'convert', type: 'numberedListItem' },
  'editor.insertTaskList': { kind: 'convert', type: 'checkListItem' },
  'editor.insertCodeBlock': { kind: 'convert', type: 'codeBlock' },
  'editor.insertTable': {
    kind: 'insert',
    block: {
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: ['', ''] }, { cells: ['', ''] }] }
    }
  },
  'editor.insertAttachment': { kind: 'insert', block: { type: 'image' } }
}

/** Pure: takes an editor-like object so it is testable without BlockNote. Returns false when a block command has no cursor block. */
export function applyEditorAction(editor: EditorHandle, action: EditorAction): boolean {
  if (action.kind === 'style') {
    editor.toggleStyles(action.styles)
    return true
  }

  const block = editor.getTextCursorPosition()?.block
  if (!block) return false

  if (action.kind === 'convert') {
    editor.updateBlock(block, {
      type: action.type,
      ...(action.props ? { props: action.props } : {})
    })
  } else {
    editor.insertBlocks([action.block], block, 'after')
  }
  return true
}

/**
 * Undo and redo from the menu. Native inputs keep the browser's own edit
 * history. The note editor's (Yjs) stack is used only while focus is inside it,
 * because the native menu role cannot reach it (see main/menu.ts). Other
 * editable surfaces (task description, agent composer) own their history, so
 * they get the native command, and non-editable focus is a no-op rather than an
 * invisible edit to a background document.
 */
export function runHistoryCommand(action: 'undo' | 'redo'): void {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    document.execCommand(action)
    return
  }

  const editor = findEditorContaining(active)
  if (editor) {
    if (action === 'undo') editor.undo()
    else editor.redo()
    return
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    document.execCommand(action)
  }
}

function runEditorAction(action: EditorAction): void {
  const editor = getEditorTarget(getActiveContext().activeTabId)
  if (!editor) return
  editor.focus()
  applyEditorAction(editor, action)
}

/**
 * The owner of the editor commands. Format and insert act on the editor the user
 * last focused in the active tab, so in a split view they follow the focused
 * pane. They are available only while that tab has an editor. Undo and redo
 * also serve inputs, so they always are.
 */
export function useEditorCommands(): void {
  const activeTabId = useAvailableCommands().activeTabId
  const hasEditor = useHasEditorTarget(activeTabId)

  const impls = Object.fromEntries(
    Object.entries(EDITOR_ACTIONS).map(([id, action]): [string, CommandImpl] => [
      id,
      { enabled: hasEditor, run: () => runEditorAction(action) }
    ])
  )

  // The keys come from `EDITOR_ACTIONS`, which is exhaustive over the ids this
  // owner is not handling by hand, so `OwnerImpls` is satisfied.
  useAppCommands('editor', {
    ...(impls as Omit<OwnerImpls<'editor'>, HistoryCommandId>),
    'editor.undo': { run: () => runHistoryCommand('undo') },
    'editor.redo': { run: () => runHistoryCommand('redo') }
  })
}
