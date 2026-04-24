/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BlockNoteEditor } from '@blocknote/core'
import { AIMenu, getDefaultAIMenuItems } from '@blocknote/xl-ai'
import { SELECTION_COMMANDS, NO_SELECTION_COMMANDS } from './ai-commands'

type AIResponseStatus =
  | 'user-input'
  | 'thinking'
  | 'ai-writing'
  | 'error'
  | 'user-reviewing'
  | 'closed'

export function CustomAIMenu(): React.JSX.Element {
  return (
    <AIMenu
      items={(editor: BlockNoteEditor<any, any, any>, status: AIResponseStatus) => {
        if (status !== 'user-input') {
          return getDefaultAIMenuItems(editor, status)
        }

        const hasSelection = !!editor.getSelection()
        const custom = hasSelection
          ? SELECTION_COMMANDS.map((factory) => factory(editor))
          : NO_SELECTION_COMMANDS.map((factory) => factory(editor))

        const customKeys = new Set(custom.map((c) => c.key))
        const defaults = getDefaultAIMenuItems(editor, status).filter(
          (item) => !customKeys.has(item.key)
        )

        return [...defaults, ...custom]
      }}
    />
  )
}
