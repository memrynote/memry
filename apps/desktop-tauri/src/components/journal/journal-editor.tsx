/**
 * Journal Editor Component
 * Tiptap-based rich text editor for journal entries
 */

import { useEffect, memo } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import tippy from 'tippy.js'
import type { Instance } from 'tippy.js'
import 'tippy.js/dist/tippy.css'
import { cn } from '@/lib/utils'
import { EditorToolbar } from './editor-toolbar'
import { WikiLink, wikiLinkStyles, WikiLinkAutocomplete } from './extensions/wiki-link'
import { Tag, tagStyles, TagAutocomplete } from './extensions/tag'
import { usePages } from '@/hooks/use-pages'
import { useTags } from '@/hooks/use-tags'

// =============================================================================
// TYPES
// =============================================================================

export interface JournalEditorProps {
  /** Initial content (HTML) */
  content?: string
  /** Placeholder text */
  placeholder?: string
  /** Whether the editor is active/focused */
  isActive?: boolean
  /** Callback when content changes */
  onContentChange?: (content: string) => void
  /** Additional CSS classes */
  className?: string
  /** Read-only mode */
  readOnly?: boolean
  /** Journal entry id (date) used to scope image uploads */
  journalId?: string
  /** Whether focus mode is currently active */
  isFocusMode?: boolean
  /** Callback fired when the toolbar focus-mode button is pressed */
  onFocusToggle?: () => void
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Journal Editor - Tiptap-based rich text editor
 */
export const JournalEditor = memo(function JournalEditor({
  content = '',
  placeholder = 'Start writing...',
  isActive = false,
  onContentChange,
  className,
  readOnly = false,
  journalId,
  isFocusMode = false,
  onFocusToggle
}: JournalEditorProps): React.JSX.Element {
  // Hooks for pages and tags
  const { searchPages } = usePages()
  const { searchTags } = useTags()

  // Initialize Tiptap editor
  const editor = useEditor(
    {
      extensions: [
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
          }
        }),
        Underline,
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            class: 'text-primary underline underline-offset-2 hover:text-primary/80'
          }
        }),
        Image.configure({
          inline: false,
          allowBase64: false,
          HTMLAttributes: {
            class: 'rounded-md max-w-full h-auto my-2'
          }
        }),
        Placeholder.configure({
          placeholder,
          emptyEditorClass: 'is-editor-empty'
        }),
        // WikiLink extension with autocomplete
        WikiLink.configure({
          suggestion: {
            items: ({ query }) => {
              return searchPages(query)
            },
            render: () => {
              let component: ReactRenderer | null = null
              let popup: Instance[] | null = null

              return {
                onStart: (props) => {
                  component = new ReactRenderer(WikiLinkAutocomplete, {
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
                onUpdate: (props) => {
                  component?.updateProps(props)
                  popup?.[0]?.setProps({
                    getReferenceClientRect: props.clientRect as () => DOMRect
                  })
                },
                onKeyDown: (props) => {
                  if (props.event.key === 'Escape') {
                    popup?.[0]?.hide()
                    return true
                  }
                  return (
                    (component?.ref as { onKeyDown?: (props: any) => boolean })?.onKeyDown?.(
                      props
                    ) ?? false
                  )
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
        }),
        // Tag extension with autocomplete
        Tag.configure({
          suggestion: {
            items: ({ query }) => {
              return searchTags(query)
            },
            render: () => {
              let component: ReactRenderer | null = null
              let popup: Instance[] | null = null

              return {
                onStart: (props) => {
                  component = new ReactRenderer(TagAutocomplete, {
                    props: { ...props, query: props.query },
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
                onUpdate: (props) => {
                  component?.updateProps({ ...props, query: props.query })
                  popup?.[0]?.setProps({
                    getReferenceClientRect: props.clientRect as () => DOMRect
                  })
                },
                onKeyDown: (props) => {
                  if (props.event.key === 'Escape') {
                    popup?.[0]?.hide()
                    return true
                  }
                  return (
                    (component?.ref as { onKeyDown?: (props: any) => boolean })?.onKeyDown?.(
                      props
                    ) ?? false
                  )
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
        })
      ],
      content,
      editable: !readOnly,
      onUpdate: ({ editor }) => {
        const html = editor.getHTML()
        onContentChange?.(html)
      },
      editorProps: {
        attributes: {
          class: cn(
            'prose prose-sm dark:prose-invert max-w-none',
            'focus:outline-none',
            'min-h-[120px] px-4 py-3',
            // Typography
            'text-[15px] leading-relaxed',
            // Headings
            'prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2',
            'prose-h1:text-xl prose-h2:text-lg prose-h3:text-base',
            // Lists
            'prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5',
            // Blockquote
            'prose-blockquote:border-l-2 prose-blockquote:border-primary/40 prose-blockquote:pl-4 prose-blockquote:italic',
            // Code
            'prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm',
            'prose-pre:bg-muted prose-pre:p-4 prose-pre:rounded-md'
          )
        }
      }
    },
    [placeholder, readOnly]
  )

  // Update content when prop changes
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content)
    }
  }, [content, editor])

  // Handle focus
  useEffect(() => {
    if (isActive && editor && !editor.isFocused) {
      // Optional: auto-focus when day becomes active
      // editor.commands.focus()
    }
  }, [isActive, editor])

  return (
    <>
      {/* Inject CSS styles for wiki-links and tags */}
      <style>{wikiLinkStyles}</style>
      <style>{tagStyles}</style>

      <div
        className={cn(
          'rounded-md border bg-background overflow-hidden',
          isActive ? 'border-border ring-1 ring-primary/20' : 'border-border/50',
          className
        )}
      >
        {/* Editor Content */}
        <EditorContent
          editor={editor}
          className="[&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:pointer-events-none"
        />

        {/* Toolbar */}
        <EditorToolbar
          editor={editor}
          journalId={journalId}
          isFocusMode={isFocusMode}
          onFocusToggle={onFocusToggle}
        />
      </div>
    </>
  )
})

export default JournalEditor
