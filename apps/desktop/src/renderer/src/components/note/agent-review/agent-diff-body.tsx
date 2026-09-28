/**
 * AgentDiffBody — a pending agent edit drawn inside the note, read-only.
 *
 * Built like `CanvasNoteBody`: the note editor's own schema on a light editor,
 * so headings, lists, tasks, callouts and embeds look exactly as they do when
 * the note is edited. Both versions are parsed through the editor's load path
 * and merged by `buildBlockDiff`; the merged document exists only here and is
 * never serialized or written anywhere.
 */
import { memo, useEffect } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useTheme } from 'next-themes'

import '@blocknote/shadcn/style.css'

import { editorSchema } from '@/components/note/content-area/editor-schema'
import {
  parseMarkdownPreservingBlanks,
  sanitizeBlockIds
} from '@/components/note/content-area/markdown-utils'
import { normalizeNoteBlocks } from '@/components/note/content-area/normalize-note-blocks'
import { TaskPrefetchProvider } from '@/components/note/content-area/task-block/task-prefetch-context'
import { normalizeMarkdownHardBreaks } from '@/components/note/content-area/wiki-link-utils'
import { useEditorTeardown } from '@/hooks/use-editor-teardown'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { buildBlockDiff, type DiffableBlock } from './block-diff'

const log = createLogger('AgentDiffBody')

async function parseBody(
  editor: Parameters<typeof parseMarkdownPreservingBlanks>[0],
  markdown: string,
  notePath: string | undefined
): Promise<DiffableBlock[]> {
  const source = normalizeMarkdownHardBreaks(markdown)
  const parsed = await parseMarkdownPreservingBlanks(editor, source, notePath)
  return sanitizeBlockIds(normalizeNoteBlocks(parsed, source)) as unknown as DiffableBlock[]
}

export const AgentDiffBody = memo(function AgentDiffBody({
  current,
  next,
  noteId,
  notePath,
  className
}: {
  current: string
  next: string
  /** Lets task blocks resolve their rows; never binds the note's Y.Doc. */
  noteId?: string
  notePath?: string
  className?: string
}): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  // `setIdAttribute` puts each block's id on its DOM node, which is what the
  // change bars in base.css select on.
  const editor = useCreateBlockNote({ schema: editorSchema, setIdAttribute: true })
  useEditorTeardown(editor)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const before = await parseBody(editor, current, notePath)
        const after = await parseBody(editor, next, notePath)
        if (cancelled) return
        const { blocks } = buildBlockDiff(before, after)
        editor.replaceBlocks(
          editor.document,
          (blocks.length > 0 ? blocks : [{ type: 'paragraph' }]) as Parameters<
            typeof editor.replaceBlocks
          >[1]
        )
      } catch (error) {
        log.error('Failed to render agent diff', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editor, current, next, notePath])

  return (
    <TaskPrefetchProvider noteId={noteId}>
      <div className={cn('content-area memry-agent-diff relative flex w-full flex-col', className)}>
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
