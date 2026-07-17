/**
 * Editor menu-command dispatch.
 *
 * Maps native menu-bar command ids (Insert/Format) onto the focused BlockNote
 * editor using its stable block-type API — block-type names match the schema,
 * unlike slash-menu titles which are localized.
 */

// ponytail: targets the last-mounted note editor (window.__memryEditor); add
// per-pane focus tracking only if split-view users hit the wrong editor.
interface EditorLike {
  toggleStyles: (styles: Record<string, unknown>) => void
  getTextCursorPosition: () => { block: unknown } | undefined
  updateBlock: (ref: unknown, update: { type: string; props?: Record<string, unknown> }) => void
  insertBlocks: (blocks: unknown[], ref: unknown, placement: 'after') => void
}

const STYLE_COMMANDS: Record<string, Record<string, unknown>> = {
  'format.bold': { bold: true },
  'format.italic': { italic: true },
  'format.code': { code: true },
  'format.strikethrough': { strike: true },
  'format.highlight': { backgroundColor: 'yellow' }
}

/** Convert the current block to a new type. */
const BLOCK_TYPE_COMMANDS: Record<string, { type: string; props?: Record<string, unknown> }> = {
  'format.heading1': { type: 'heading', props: { level: 1 } },
  'format.heading2': { type: 'heading', props: { level: 2 } },
  'format.heading3': { type: 'heading', props: { level: 3 } },
  'format.body': { type: 'paragraph' },
  'insert.bulletList': { type: 'bulletListItem' },
  'insert.numberedList': { type: 'numberedListItem' },
  'insert.taskList': { type: 'checkListItem' },
  'insert.codeBlock': { type: 'codeBlock' }
}

/** Insert a fresh block after the current one. */
const INSERT_BLOCK_COMMANDS: Record<string, unknown> = {
  'insert.table': {
    type: 'table',
    content: { type: 'tableContent', rows: [{ cells: ['', ''] }, { cells: ['', ''] }] }
  },
  'insert.attachment': { type: 'image' }
}

export function isEditorMenuCommand(command: string): boolean {
  return (
    command in STYLE_COMMANDS || command in BLOCK_TYPE_COMMANDS || command in INSERT_BLOCK_COMMANDS
  )
}

/** Pure mapping — takes an editor-like object so it is testable without BlockNote. */
export function applyEditorMenuCommand(editor: EditorLike, command: string): boolean {
  const styles = STYLE_COMMANDS[command]
  if (styles) {
    editor.toggleStyles(styles)
    return true
  }

  const block = editor.getTextCursorPosition()?.block
  if (!block) return false

  const conversion = BLOCK_TYPE_COMMANDS[command]
  if (conversion) {
    editor.updateBlock(block, conversion)
    return true
  }

  const insert = INSERT_BLOCK_COMMANDS[command]
  if (insert) {
    editor.insertBlocks([insert], block, 'after')
    return true
  }

  return false
}

export function runEditorMenuCommand(command: string): void {
  const editor = (window as unknown as { __memryEditor?: EditorLike & { focus?: () => void } })
    .__memryEditor
  if (!editor) return
  try {
    editor.focus?.()
    applyEditorMenuCommand(editor, command)
  } catch {
    // Editor not ready or block-shape drift — fail quietly rather than crash the menu.
  }
}

/**
 * Menu-bar Undo/Redo. Native inputs keep the browser's own edit history;
 * everything else routes to the BlockNote editor's (Yjs) undo stack — the
 * native menu role can't reach it (see main/menu.ts).
 */
export function runHistoryMenuCommand(action: 'undo' | 'redo'): void {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    document.execCommand(action)
    return
  }

  const editor = (
    window as unknown as { __memryEditor?: { undo?: () => boolean; redo?: () => boolean } }
  ).__memryEditor
  if (!editor) return
  try {
    if (action === 'undo') editor.undo?.()
    else editor.redo?.()
  } catch {
    // Editor not ready — fail quietly rather than crash the menu.
  }
}
