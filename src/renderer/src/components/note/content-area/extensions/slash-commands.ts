/**
 * Slash Commands Extension
 * TipTap extension for "/" triggered command menu
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import type { SuggestionOptions } from '@tiptap/suggestion'

// =============================================================================
// EXTENSION OPTIONS
// =============================================================================

export interface SlashCommandsOptions {
  /**
   * Suggestion configuration
   * Items and render functions should be provided here
   */
  suggestion: Omit<SuggestionOptions, 'editor'>
}

// =============================================================================
// PLUGIN KEY
// =============================================================================

export const slashCommandsPluginKey = new PluginKey('slashCommands')

// =============================================================================
// EXTENSION
// =============================================================================

/**
 * SlashCommands Extension
 *
 * Triggers a command menu when user types "/" at the start of a line
 * or after a space. Uses the TipTap suggestion plugin pattern.
 *
 * @example
 * ```ts
 * SlashCommands.configure({
 *   suggestion: {
 *     items: ({ query }) => filterCommands(query),
 *     render: () => createSlashMenuRenderer()
 *   }
 * })
 * ```
 */
export const SlashCommands = Extension.create<SlashCommandsOptions>({
  name: 'slashCommands',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        pluginKey: slashCommandsPluginKey,
        allowSpaces: false,
        startOfLine: false,

        // Default command - override via configure()
        command: ({ editor, range, props }) => {
          // Delete the "/" trigger
          editor.chain().focus().deleteRange(range).run()

          // Execute the selected command
          if (props && typeof props.command === 'function') {
            props.command(editor)
          }
        },

        // Allow "/" only at start of line or after whitespace
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          const textBefore = $from.parent.textBetween(
            Math.max(0, range.from - $from.start() - 1),
            range.from - $from.start(),
            undefined,
            '\ufffc'
          )

          // Allow if at start of block or after whitespace
          return textBefore === '' || /\s$/.test(textBefore)
        }
      }
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion
      })
    ]
  }
})

export default SlashCommands
