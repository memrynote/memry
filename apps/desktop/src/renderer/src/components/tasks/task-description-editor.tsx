/**
 * TaskDescriptionEditor
 * BlockNote-based rich text editor for a task's description.
 * Reads/writes a plain markdown string (no Yjs, no IPC) so the existing
 * `description` text column and field-level sync are unchanged.
 * Modeled on InboxContentEditor; links open externally like the note editor.
 */

import { memo, useCallback, useEffect, useRef } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { useEditorTeardown } from '@/hooks/use-editor-teardown'
import { BlockNoteView } from '@blocknote/shadcn'
import { useTheme } from 'next-themes'

import '@blocknote/shadcn/style.css'

import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:TaskDescriptionEditor')

interface TaskDescriptionEditorProps {
  /** Initial content (markdown). Loaded once on mount — remount via `key` to swap tasks. */
  initialContent: string | null
  /** Called with the serialized markdown when content changes. */
  onContentChange?: (markdown: string) => void
  /** Whether the editor is editable. */
  editable?: boolean
  /** Placeholder shown in the empty editor. */
  placeholder?: string
  /** Optional className for the wrapper. */
  className?: string
  /** Optional aria-label for the editor region. */
  ariaLabel?: string
}

export const TaskDescriptionEditor = memo(function TaskDescriptionEditor({
  initialContent,
  onContentChange,
  editable = true,
  placeholder = 'Add a description…',
  className,
  ariaLabel
}: TaskDescriptionEditorProps) {
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'

  const initialContentLoadedRef = useRef(false)
  const isContentReadyRef = useRef(false)

  const editor = useCreateBlockNote({
    // Same header-row toggle the note body gets — the same markdown round-trip
    // applies here, so the two surfaces have to agree about tables.
    tables: { headers: true },
    placeholders: {
      default: placeholder,
      heading: 'Heading',
      bulletListItem: 'List item',
      numberedListItem: 'List item',
      checkListItem: 'To-do item'
    }
  })

  // `useCreateBlockNote` never disposes what it builds.
  useEditorTeardown(editor)

  // Parse and load initial markdown once.
  useEffect(() => {
    if (initialContentLoadedRef.current) return
    initialContentLoadedRef.current = true

    async function loadContent() {
      if (typeof initialContent !== 'string' || !initialContent.trim()) {
        isContentReadyRef.current = true
        return
      }
      try {
        // BlockNote's parse helper resolves asynchronously at runtime despite
        // its synchronous type, so await a wrapped Promise.
        const blocks = await Promise.resolve(editor.tryParseMarkdownToBlocks(initialContent))
        if (blocks.length > 0) {
          editor.replaceBlocks(editor.document, blocks)
        }
      } catch (error) {
        log.error('Failed to parse task description markdown', error)
      } finally {
        isContentReadyRef.current = true
      }
    }
    void loadContent()
  }, [editor, initialContent])

  const handleChange = useCallback(async () => {
    if (!isContentReadyRef.current || !onContentChange) return
    try {
      const markdown = await Promise.resolve(editor.blocksToMarkdownLossy(editor.document))
      // Normalize an empty doc to '' so clearing the field matches the old textarea.
      onContentChange(markdown.trim() ? markdown : '')
    } catch (error) {
      log.error('Failed to serialize task description', error)
    }
  }, [editor, onContentChange])

  // Open link clicks externally, like the note editor (window.open is routed
  // to the OS browser by the main-process openExternal allowlist).
  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a')
    const href = link?.getAttribute('href')
    if (href && !href.startsWith('#')) {
      e.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }, [])

  return (
    <section
      className={cn('task-description-editor relative', editable && 'cursor-text', className)}
      aria-label={ariaLabel}
      onClick={handleContainerClick}
    >
      <BlockNoteView
        editor={editor}
        editable={editable}
        onChange={() => void handleChange()}
        theme={editorTheme}
      />
    </section>
  )
})

export default TaskDescriptionEditor
