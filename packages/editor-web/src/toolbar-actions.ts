import type {
  ConvertibleBlock,
  InlineStyle,
  InsertBlockAction,
  StyleAction,
  TableAction,
  ToolbarAction
} from '@memry/contracts/webview-bridge'

/**
 * What the native toolbar can do to the document.
 *
 * The toolbar itself is a React Native view (`apps/mobile/src/editor/toolbar`);
 * every press reaches the guest as a `toolbar-action` and lands on one of
 * these. The methods keep the semantics the DOM toolbar had — most hand focus
 * back to the editor afterwards, the style panel deliberately does not.
 */
export interface EditorToolbarActions {
  insert(action: InsertBlockAction): void
  tableAction(action: TableAction): void
  styleAction(action: StyleAction): void
  turnInto(block: ConvertibleBlock): void
  toggleStyle(style: InlineStyle): void
  toggleBulletedList(): void
  createLink(url: string): void
  focusEditor(): void
  insertWikiLink(): void
  insertImage(): void
  undo(): void
  redo(): void
  dismissKeyboard(): void
  /** The `•••`: open the guest's block-actions sheet for the caret's block (#2100). */
  openBlockActions(): void
}

export function dispatchToolbarAction(actions: EditorToolbarActions, action: ToolbarAction): void {
  switch (action.kind) {
    case 'toggle-style':
      actions.toggleStyle(action.style)
      return
    case 'turn-into':
      actions.turnInto(action.block)
      return
    case 'insert':
      actions.insert(action.action)
      return
    case 'table':
      actions.tableAction(action.action)
      return
    case 'style':
      actions.styleAction(action.action)
      return
    case 'toggle-bulleted-list':
      actions.toggleBulletedList()
      return
    case 'create-link':
      actions.createLink(action.url)
      return
    case 'focus':
      actions.focusEditor()
      return
    case 'insert-wiki-link':
      actions.insertWikiLink()
      return
    case 'insert-image':
      actions.insertImage()
      return
    case 'undo':
      actions.undo()
      return
    case 'redo':
      actions.redo()
      return
    case 'blur':
      actions.dismissKeyboard()
      return
    case 'open-block-actions':
      actions.openBlockActions()
      return
    default: {
      const _exhaustive: never = action
      void _exhaustive
    }
  }
}
