/**
 * Content Area Component
 * Main TipTap-based rich text editor for note content
 */

import { memo, useCallback, useEffect } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import type { SuggestionProps } from '@tiptap/suggestion'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import Underline from '@tiptap/extension-underline'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import tippy from 'tippy.js'
import type { Instance } from 'tippy.js'
import 'tippy.js/dist/tippy.css'

import { cn } from '@/lib/utils'
import { WikiLink, wikiLinkStyles, WikiLinkAutocomplete } from '@/components/journal/extensions/wiki-link'
import { Tag, tagStyles, TagAutocomplete } from '@/components/journal/extensions/tag'
import { usePages } from '@/hooks/use-pages'
import { useTags } from '@/hooks/use-tags'

import { ContentDivider } from './ContentDivider'
import { FloatingToolbar } from './FloatingToolbar'
import { SlashCommands } from './extensions/slash-commands'
import { HeadingExtractor } from './extensions/heading-extractor'
import { Callout } from './extensions/callout'
import { SlashCommandMenu, filterSlashCommands } from './SlashCommandMenu'
import { allEditorClasses, placeholderClasses } from './styles/editor-styles'
import type { ContentAreaProps, HeadingInfo, SlashCommandItem } from './types'

// =============================================================================
// SUGGESTION RENDERER FACTORY
// =============================================================================

/**
 * Creates a suggestion renderer using tippy.js and ReactRenderer
 * This is the proven pattern from wiki-link and tag extensions
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSuggestionRenderer<T>(Component: React.ComponentType<T>) {
  return () => {
    let component: ReactRenderer | null = null
    let popup: Instance[] | null = null

    return {
      onStart: (props: SuggestionProps<unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component = new ReactRenderer(Component as React.ComponentType<any>, {
          props,
          editor: props.editor
        })

        popup = tippy('body', {
          getReferenceClientRect: props.clientRect as () => DOMRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start'
        })
      },

      onUpdate: (props: SuggestionProps<unknown>) => {
        component?.updateProps(props)
        popup?.[0]?.setProps({
          getReferenceClientRect: props.clientRect as () => DOMRect
        })
      },

      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === 'Escape') {
          popup?.[0]?.hide()
          return true
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (component?.ref as any)?.onKeyDown?.(props) ?? false
      },

      onExit: () => {
        popup?.[0]?.destroy()
        component?.destroy()
        component = null
        popup = null
      }
    }
  }
}

// =============================================================================
// CSS STYLES
// =============================================================================

/**
 * Additional CSS styles for callout blocks
 */
const calloutStyles = `
.ProseMirror [data-callout] {
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  margin: 1rem 0;
  border-width: 1px;
}

.ProseMirror [data-callout][data-variant="info"] {
  background-color: rgb(239 246 255);
  border-color: rgb(191 219 254);
}

.ProseMirror [data-callout][data-variant="warning"] {
  background-color: rgb(255 251 235);
  border-color: rgb(253 230 138);
}

.ProseMirror [data-callout][data-variant="error"] {
  background-color: rgb(254 242 242);
  border-color: rgb(254 202 202);
}

.ProseMirror [data-callout][data-variant="success"] {
  background-color: rgb(240 253 244);
  border-color: rgb(187 247 208);
}
`

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * ContentArea - Main rich text editor component
 *
 * Features:
 * - TipTap-based rich text editing
 * - Slash commands for block insertion
 * - Floating toolbar on text selection
 * - WikiLink and Tag support (reused from journal)
 * - Heading extraction for outline panel
 * - Task lists, tables, images, and more
 */
export const ContentArea = memo(function ContentArea({
  content,
  placeholder = "Start writing, or press '/' for commands...",
  readOnly = false,
  autoFocus = false,
  onContentChange,
  onHeadingsChange,
  onSelectionChange,
  onLinkClick,
  onInternalLinkClick,
  className
}: ContentAreaProps) {
  // Hooks for pages and tags (for wiki-links and hashtags)
  const { searchPages } = usePages()
  const { searchTags } = useTags()

  // Memoized heading change handler
  const handleHeadingsChange = useCallback(
    (headings: HeadingInfo[]) => {
      onHeadingsChange(headings)
    },
    [onHeadingsChange]
  )

  // Initialize TipTap editor
  const editor = useEditor(
    {
      extensions: [
        // Core extensions
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3]
          },
          bulletList: {
            keepMarks: true,
            keepAttributes: false
          },
          orderedList: {
            keepMarks: true,
            keepAttributes: false
          },
          codeBlock: {
            HTMLAttributes: {
              class: 'bg-stone-900 text-stone-100 rounded-lg p-4 font-mono text-sm overflow-x-auto'
            }
          }
        }),

        // Additional formatting
        Underline,

        // Placeholder
        Placeholder.configure({
          placeholder,
          emptyEditorClass: 'is-editor-empty'
        }),

        // Links
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            class: 'text-blue-600 hover:underline cursor-pointer'
          }
        }),

        // Task lists
        TaskList,
        TaskItem.configure({
          nested: true
        }),

        // Images
        Image.configure({
          inline: false,
          allowBase64: true
        }),

        // Tables
        Table.configure({
          resizable: true
        }),
        TableRow,
        TableHeader,
        TableCell,

        // WikiLink extension with autocomplete
        WikiLink.configure({
          suggestion: {
            items: ({ query }) => searchPages(query),
            render: createSuggestionRenderer(WikiLinkAutocomplete)
          }
        }),

        // Tag extension with autocomplete
        Tag.configure({
          suggestion: {
            items: ({ query }) => searchTags(query),
            render: createSuggestionRenderer(TagAutocomplete)
          }
        }),

        // Slash commands
        SlashCommands.configure({
          suggestion: {
            items: ({ query }) => filterSlashCommands(query),
            render: createSuggestionRenderer(SlashCommandMenu),
            command: ({ editor: e, range, props }) => {
              // Delete the "/" trigger
              e.chain().focus().deleteRange(range).run()
              // Execute the selected command
              const item = props as SlashCommandItem
              if (item && typeof item.command === 'function') {
                item.command(e)
              }
            }
          }
        }),

        // Heading extractor for outline
        HeadingExtractor.configure({
          onHeadingsChange: handleHeadingsChange
        }),

        // Callout blocks
        Callout
      ],

      content,
      editable: !readOnly,
      autofocus: autoFocus,

      // Content change handler
      onUpdate: ({ editor: e }) => {
        const html = e.getHTML()
        onContentChange(html)
      },

      // Selection change handler
      onSelectionUpdate: ({ editor: e }) => {
        if (onSelectionChange) {
          const { from, to } = e.state.selection
          const text = e.state.doc.textBetween(from, to)
          onSelectionChange({
            from,
            to,
            text,
            isEmpty: from === to
          })
        }
      },

      // Editor props for styling and click handling
      editorProps: {
        attributes: {
          class: allEditorClasses,
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Note content'
        },

        // Handle clicks on links and wiki-links
        handleClickOn: (_view, _pos, _node, _nodePos, event) => {
          const target = event.target as HTMLElement

          // Handle wiki-link clicks
          if (target.hasAttribute('data-wiki-link')) {
            const href = target.getAttribute('data-href')
            if (href && onInternalLinkClick) {
              onInternalLinkClick(href)
              return true
            }
          }

          // Handle external link clicks
          if (target.tagName === 'A') {
            const href = target.getAttribute('href')
            if (href && onLinkClick) {
              onLinkClick(href)
              return true
            }
          }

          return false
        }
      }
    },
    [placeholder, readOnly, handleHeadingsChange]
  )

  // Update content when prop changes (for controlled component)
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content)
    }
  }, [content, editor])

  return (
    <>
      {/* Inject CSS styles */}
      <style>{wikiLinkStyles}</style>
      <style>{tagStyles}</style>
      <style>{calloutStyles}</style>

      <div className={cn('content-area', className)}>
        {/* Content Divider */}
        <ContentDivider />

        {/* Editor */}
        <div
          className="min-h-[300px] cursor-text"
          onClick={() => {
            // Focus editor when clicking the container
            if (editor && !editor.isFocused) {
              editor.commands.focus('end')
            }
          }}
        >
          <EditorContent editor={editor} className={placeholderClasses} />
        </div>

        {/* Floating Toolbar */}
        <FloatingToolbar editor={editor} />
      </div>
    </>
  )
})

export default ContentArea
