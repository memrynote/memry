/**
 * Tag Tiptap Extension
 * Custom node for #tag syntax
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import type { SuggestionOptions } from '@tiptap/suggestion'

export interface TagOptions {
  HTMLAttributes: Record<string, unknown>
  suggestion: Omit<SuggestionOptions, 'editor'>
}

export interface TagAttributes {
  tag: string
}

/**
 * Tag Node Extension
 * Creates atomic, selectable tag nodes triggered by #
 */
export const Tag = Node.create<TagOptions>({
  name: 'tag',

  group: 'inline',

  inline: true,

  selectable: true,

  atom: true, // Treated as a single, indivisible unit

  addOptions() {
    return {
      HTMLAttributes: {},
      suggestion: {
        char: '#',
        allowSpaces: false, // Tags cannot contain spaces
        pluginKey: new PluginKey('tagSuggestion'),
        command: ({ editor, range, props }) => {
          // Delete the # trigger and insert tag node, then add space
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: this.name,
              attrs: props
            })
            .insertContent(' ') // Add space after tag
            .run()
        }
      }
    }
  },

  addAttributes() {
    return {
      tag: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-tag'),
        renderHTML: (attributes) => {
          if (!attributes.tag) {
            return {}
          }
          return {
            'data-tag': attributes.tag
          }
        }
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-tag-node]'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-tag-node': '',
        class: 'tag',
        role: 'button',
        tabindex: '0',
        'aria-label': `Tag: ${HTMLAttributes.tag}, click to filter`
      }),
      `#${HTMLAttributes.tag}`
    ]
  },

  renderText({ node }) {
    return `#${node.attrs.tag}`
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const result = this.editor.commands.command(({ tr, state }) => {
          let isTag = false
          const { selection } = state
          const { empty, anchor } = selection

          if (!empty) {
            return false
          }

          state.doc.nodesBetween(anchor - 1, anchor, (node, pos) => {
            if (node.type.name === this.name) {
              isTag = true
              tr.delete(pos, pos + node.nodeSize)
              return false
            }
            return true
          })

          return isTag
        })
        return result
      }
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        // Allow alphanumeric, hyphens, underscores
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          const text = $from.parent.textBetween(
            Math.max(0, range.from - $from.start()),
            range.to - $from.start(),
            undefined,
            '\ufffc'
          )

          // Extract text after #
          const tagText = text.slice(1) // Remove # character

          return tagText === '' || /^[a-zA-Z0-9_\-/]*$/.test(tagText)
        }
      })
    ]
  }
})

// CSS styles for tag rendering
export const tagStyles = `
.tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  margin: 0 2px;
  background-color: hsl(var(--accent));
  color: hsl(var(--accent-foreground));
  border-radius: 12px;
  font-size: 0.9em;
  cursor: pointer;
  transition: background-color 150ms ease;
  white-space: nowrap;
}

.tag:hover {
  background-color: hsl(var(--accent) / 0.8);
}

.tag:focus {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
`
