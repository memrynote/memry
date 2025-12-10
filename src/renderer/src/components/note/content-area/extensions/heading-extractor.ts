/**
 * Heading Extractor Extension
 * TipTap extension that extracts heading information for the outline panel
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'
import type { HeadingInfo } from '../types'

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Debounce function to prevent excessive callback invocations
 */
function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    timeoutId = setTimeout(() => {
      fn(...args)
      timeoutId = null
    }, ms)
  }
}

/**
 * Extract headings from a ProseMirror document
 */
function extractHeadings(doc: Node, view: EditorView): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  let index = 0

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = node.attrs.level as 1 | 2 | 3

      // Only process h1, h2, h3
      if (level >= 1 && level <= 3) {
        // Try to get DOM position for accurate offset
        let position = 0
        try {
          const dom = view.nodeDOM(pos) as HTMLElement | null
          if (dom) {
            position = dom.offsetTop
          }
        } catch {
          // DOM might not be ready, use 0 as fallback
          position = 0
        }

        headings.push({
          id: `heading-${index}`,
          text: node.textContent || '',
          level,
          position
        })

        index++
      }
    }
  })

  return headings
}

// =============================================================================
// EXTENSION OPTIONS
// =============================================================================

export interface HeadingExtractorOptions {
  /**
   * Callback invoked when headings change
   */
  onHeadingsChange: (headings: HeadingInfo[]) => void
  /**
   * Debounce delay in milliseconds
   * @default 250
   */
  debounceMs?: number
}

// =============================================================================
// EXTENSION
// =============================================================================

/**
 * HeadingExtractor Extension
 *
 * Listens to document changes and extracts heading information
 * for the outline/table of contents panel.
 *
 * @example
 * ```ts
 * HeadingExtractor.configure({
 *   onHeadingsChange: (headings) => setOutlineHeadings(headings)
 * })
 * ```
 */
export const HeadingExtractor = Extension.create<HeadingExtractorOptions>({
  name: 'headingExtractor',

  addOptions() {
    return {
      onHeadingsChange: () => {},
      debounceMs: 250
    }
  },

  addProseMirrorPlugins() {
    const { onHeadingsChange, debounceMs } = this.options

    // Create debounced extraction function
    const debouncedExtract = debounce((doc: Node, view: EditorView) => {
      const headings = extractHeadings(doc, view)
      onHeadingsChange(headings)
    }, debounceMs ?? 250)

    return [
      new Plugin({
        key: new PluginKey('headingExtractor'),

        view: () => ({
          update: (view, prevState) => {
            // Only extract if document changed
            if (!view.state.doc.eq(prevState.doc)) {
              debouncedExtract(view.state.doc, view)
            }
          }
        })
      })
    ]
  }
})

export default HeadingExtractor
