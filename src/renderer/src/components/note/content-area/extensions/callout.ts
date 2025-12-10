/**
 * Callout Extension
 * TipTap extension for callout/admonition blocks
 */

import { Node, mergeAttributes } from '@tiptap/core'
import type { CalloutVariant } from '../types'

// =============================================================================
// EXTENSION OPTIONS
// =============================================================================

export interface CalloutOptions {
  /**
   * HTML attributes to add to the callout element
   */
  HTMLAttributes: Record<string, unknown>
}

// =============================================================================
// TYPE AUGMENTATION
// =============================================================================

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /**
       * Set a callout block
       */
      setCallout: (variant?: CalloutVariant) => ReturnType
      /**
       * Toggle a callout block
       */
      toggleCallout: (variant?: CalloutVariant) => ReturnType
      /**
       * Unset (remove) a callout block
       */
      unsetCallout: () => ReturnType
    }
  }
}

// =============================================================================
// EXTENSION
// =============================================================================

/**
 * Callout Extension
 *
 * Creates callout/admonition blocks with different variants:
 * - info (blue)
 * - warning (amber)
 * - error (red)
 * - success (green)
 *
 * @example
 * ```ts
 * // Insert a callout
 * editor.chain().focus().setCallout('info').run()
 *
 * // Toggle callout
 * editor.chain().focus().toggleCallout('warning').run()
 * ```
 */
export const Callout = Node.create<CalloutOptions>({
  name: 'callout',

  group: 'block',

  content: 'block+',

  defining: true,

  addOptions() {
    return {
      HTMLAttributes: {}
    }
  },

  addAttributes() {
    return {
      variant: {
        default: 'info' as CalloutVariant,
        parseHTML: (element) =>
          (element.getAttribute('data-variant') as CalloutVariant) || 'info',
        renderHTML: (attributes) => ({
          'data-variant': attributes.variant
        })
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-callout]'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-callout': ''
      }),
      0 // Content placeholder
    ]
  },

  addCommands() {
    return {
      setCallout:
        (variant: CalloutVariant = 'info') =>
        ({ commands }) => {
          return commands.wrapIn(this.name, { variant })
        },

      toggleCallout:
        (variant: CalloutVariant = 'info') =>
        ({ commands }) => {
          return commands.toggleWrap(this.name, { variant })
        },

      unsetCallout:
        () =>
        ({ commands }) => {
          return commands.lift(this.name)
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      // Mod+Shift+C to toggle callout
      'Mod-Shift-c': () => this.editor.commands.toggleCallout('info')
    }
  }
})

export default Callout
