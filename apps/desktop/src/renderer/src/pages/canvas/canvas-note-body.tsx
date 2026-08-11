/**
 * CanvasNoteBody — a note's body rendered exactly as the note editor renders it,
 * read-only, for an idle canvas card.
 *
 * Fidelity comes from reusing `editorSchema` (the note editor's own block +
 * inline specs: file, callout, youtubeEmbed, bookmark, taskBlock, wiki links,
 * hash tags, date mentions) with `@blocknote/shadcn`'s stylesheet, so images,
 * headings, lists and checkboxes look identical to the active card. A
 * hand-written markdown renderer cannot reproduce those custom blocks and would
 * drift from the editor on every schema change.
 *
 * This is deliberately NOT <ContentArea>: the active card owns editing (Yjs
 * binding, task auto-conversion, AI menus, upload handling). An idle card only
 * paints, so it mounts the light editor — the same reason
 * task-description-editor.tsx exists next to ContentArea.
 *
 * Markdown is re-parsed whenever the body changes, so a card stays live while
 * the same note is edited in a tab (use-canvas-entities pushes the new body).
 */
import React, { memo, useEffect } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { useEditorTeardown } from '@/hooks/use-editor-teardown'
import { BlockNoteView } from '@blocknote/shadcn'
import { useTheme } from 'next-themes'

import '@blocknote/shadcn/style.css'

import { editorSchema } from '@/components/note/content-area/editor-schema'
import {
  parseMarkdownPreservingBlanks,
  sanitizeBlockIds
} from '@/components/note/content-area/markdown-utils'
import { normalizeNoteBlocks } from '@/components/note/content-area/normalize-note-blocks'
import { normalizeMarkdownHardBreaks } from '@/components/note/content-area/wiki-link-utils'
import { TaskPrefetchProvider } from '@/components/note/content-area/task-block/task-prefetch-context'
import { createLogger } from '@/lib/logger'

const log = createLogger('CanvasNoteBody')

interface CanvasNoteBodyProps {
  /** The note's markdown content. */
  markdown: string
  /** Batches the linked-task fetch so every taskBlock resolves in one IPC. */
  noteId: string
}

export const CanvasNoteBody = memo(function CanvasNoteBody({
  markdown,
  noteId
}: CanvasNoteBodyProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const editor = useCreateBlockNote({ schema: editorSchema })

  // `useCreateBlockNote` never disposes what it builds.
  useEditorTeardown(editor)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        // The editor's own load path, not a bare tryParseMarkdownToBlocks:
        // callouts, embeds, bookmarks, files and blank lines come from
        // parseMarkdownPreservingBlanks, and normalizeNoteBlocks turns the
        // markdown markers back into real blocks — without it a
        // `- [ ] Ship it {task:abc}` line renders as literal marker text
        // instead of the task renderer.
        const parsed = await parseMarkdownPreservingBlanks(
          editor,
          normalizeMarkdownHardBreaks(markdown)
        )
        const blocks = sanitizeBlockIds(normalizeNoteBlocks(parsed))
        if (cancelled) return
        editor.replaceBlocks(editor.document, blocks.length > 0 ? blocks : [{ type: 'paragraph' }])
      } catch (error) {
        log.error('Failed to render canvas note body', error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [editor, markdown])

  return (
    // Mirrors ContentArea's own wrapper chain (content-area → bn-container) so
    // the idle card and the active editor pick up the same BlockNote layout
    // rules. ContentArea's min-h-[300px] is intentionally dropped: on a card it
    // would make every short note scrollable.
    <TaskPrefetchProvider noteId={noteId}>
      <div className="content-area relative flex w-full flex-col">
        <div className="bn-container relative flex-1">
          <BlockNoteView
            editor={editor}
            editable={false}
            theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
          />
        </div>
      </div>
    </TaskPrefetchProvider>
  )
})
