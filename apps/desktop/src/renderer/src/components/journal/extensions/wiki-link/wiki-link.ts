/**
 * WikiLink Tiptap Extension
 * Custom node for [[Page Name]] wiki-link syntax
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import type { SuggestionOptions } from '@tiptap/suggestion'

export interface WikiLinkOptions {
  HTMLAttributes: Record<string, unknown>
  suggestion: Omit<SuggestionOptions, 'editor'>
}

export interface WikiLinkAttributes {
  href: string
  title: string
  exists: boolean
}

/**
 * WikiLink Node Extension
 * Creates atomic, selectable wiki-link nodes triggered by [[
 */
export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',

  group: 'inline',

  inline: true,

  selectable: true,

  atom: true, // Treated as a single, indivisible unit

  addOptions() {
    return {
      HTMLAttributes: {},
      suggestion: {
        char: '[[',
        pluginKey: new PluginKey('wikiLinkSuggestion'),
        command: ({ editor, range, props }) => {
          // Delete the [[ trigger and insert wiki-link node
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: this.name,
              attrs: props
            })
            .run()
        }
      }
    }
  },

  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-href'),
        renderHTML: (attributes) => {
          if (!attributes.href) {
            return {}
          }
          return {
            'data-href': attributes.href
          }
        }
      },
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-title'),
        renderHTML: (attributes) => {
          if (!attributes.title) {
            return {}
          }
          return {
            'data-title': attributes.title
          }
        }
      },
      exists: {
        default: true,
        parseHTML: (element) => {
          const exists = element.getAttribute('data-exists')
          return exists === 'false' ? false : true
        },
        renderHTML: (attributes) => {
          return {
            'data-exists': attributes.exists
          }
        }
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const classes = ['wiki-link']
    if (HTMLAttributes.exists === false || HTMLAttributes.exists === 'false') {
      classes.push('wiki-link-broken')
    }

    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-wiki-link': '',
        class: classes.join(' '),
        role: 'link',
        tabindex: '0',
        'aria-label': `Link to ${HTMLAttributes.title}`
      }),
      HTMLAttributes.title || ''
    ]
  },

  renderText({ node }) {
    return `[[${node.attrs.title}]]`
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const result = this.editor.commands.command(({ tr, state }) => {
          let isWikiLink = false
          const { selection } = state
          const { empty, anchor } = selection

          if (!empty) {
            return false
          }

          state.doc.nodesBetween(anchor - 1, anchor, (node, pos) => {
            if (node.type.name === this.name) {
              isWikiLink = true
              tr.delete(pos, pos + node.nodeSize)
              return false
            }
            return true
          })

          return isWikiLink
        })
        return result
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

// CSS styles for wiki-link rendering
export const wikiLinkStyles = `
.wiki-link {
  color: hsl(var(--primary));
  cursor: pointer;
  border-radius: 2px;
  transition: background-color 150ms ease;
  padding: 0 1px;
}

.wiki-link:hover {
  text-decoration: underline;
  background-color: hsl(var(--accent) / 0.1);
}

.wiki-link-broken {
  color: hsl(var(--muted-foreground));
  text-decoration: underline dashed;
  text-underline-offset: 2px;
}

.wiki-link-broken:hover {
  text-decoration: underline dashed;
  background-color: hsl(var(--muted) / 0.1);
}
`
