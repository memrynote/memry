/**
 * The note page's similarity surfaces (#2490), wired to data and actions.
 *
 * Kept out of NotePage so the page only says where they go: every branch here
 * (hidden while dismissed, link only with a live editor, canvas only with the
 * feature on) would otherwise add to an already large component.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { SimilarNoteItem } from '@memry/contracts/notes-api'
import { useT } from '@memry/i18n/renderer'
import { createWikiLinkInlineContent } from '@/components/note/content-area/wiki-link'
import { useTabs } from '@/contexts/tabs'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useSimilarNotes, useTagSuggestions } from '@/hooks/use-note-similarity'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { addItemsToCanvas } from '@/pages/canvas/canvas-write'
import type { CanvasOption } from './AddToCanvasPicker'
import { SimilarNotesSection } from './SimilarNotesSection'
import { SuggestedTagsRow } from './SuggestedTagsRow'

const log = createLogger('NoteSimilarity')

/** The slice of the BlockNote editor a link append needs. */
interface AppendableEditor {
  document: Array<{ id: string; type: string; content?: unknown }>
  insertBlocks: (blocks: unknown[], reference: string, placement: 'after') => unknown
  updateBlock: (reference: string, update: unknown) => unknown
}

/**
 * A `[[Title]]` paragraph at the end of the body, written through the live
 * editor so the CRDT binding and undo history see it like typing. A trailing
 * empty paragraph is reused so repeated links leave no blank lines between.
 */
function appendWikiLink(editor: AppendableEditor, title: string): boolean {
  const last = editor.document[editor.document.length - 1]
  if (!last) return false
  const content = [createWikiLinkInlineContent(title, '')]
  const lastIsEmpty =
    last.type === 'paragraph' && Array.isArray(last.content) && last.content.length === 0
  if (lastIsEmpty) editor.updateBlock(last.id, { type: 'paragraph', content })
  else editor.insertBlocks([{ type: 'paragraph', content }], last.id, 'after')
  return true
}

/** Opens a tab, honouring the page's reuse-tab preference. */
type OpenTab = (tab: Parameters<ReturnType<typeof useTabs>['openTab']>[0]) => void

export function NoteSimilarNotes({
  noteId,
  getEditor,
  largeFile,
  reviewing,
  deleted,
  openLinked
}: {
  noteId: string
  getEditor: () => unknown
  /** Any of these three means there is no live editor to link from. */
  largeFile: boolean
  reviewing: boolean
  deleted: boolean
  openLinked: OpenTab
}): React.JSX.Element | null {
  const { t } = useT('notes')
  const notes = useSimilarNotes(noteId)
  const { flags } = useFeatureFlags()
  const { openTab } = useTabs()

  const handleLink = useCallback(
    (similar: SimilarNoteItem) => {
      const editor = getEditor() as AppendableEditor | null
      if (editor && appendWikiLink(editor, similar.title)) {
        toast.success(t('similarNotes.linked', { title: similar.title }))
      }
    },
    [getEditor, t]
  )

  const handleAddToCanvas = useCallback(
    async (similar: SimilarNoteItem, canvas: CanvasOption) => {
      const values = { title: similar.title, canvas: canvas.title }
      try {
        const { mutation } = await addItemsToCanvas(canvas.id, [
          { entityType: 'note', entityId: similar.id }
        ])
        if (mutation.applied.length === 0) {
          toast.info(t('similarNotes.alreadyOnCanvas', values))
          return
        }
        toast.success(t('similarNotes.addedToCanvas', values), {
          action: {
            label: t('similarNotes.openCanvas'),
            onClick: () =>
              openTab({
                type: 'canvas',
                title: canvas.title,
                icon: 'pen-tool',
                path: `/canvas/${canvas.id}`,
                entityId: canvas.id,
                isPinned: false,
                isModified: false,
                isPreview: false,
                isDeleted: false
              })
          }
        })
      } catch (err) {
        log.error('Failed to add similar note to canvas', err)
        toast.error(extractErrorMessage(err, t('similarNotes.addToCanvasFailed')))
      }
    },
    [openTab, t]
  )

  const handleOpen = useCallback(
    (similar: SimilarNoteItem) =>
      openLinked({
        type: 'note',
        title: similar.title,
        icon: 'file-text',
        path: `/notes/${similar.id}`,
        entityId: similar.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      }),
    [openLinked]
  )

  const canLink = !largeFile && !reviewing && !deleted

  return (
    <SimilarNotesSection
      notes={notes}
      onOpen={handleOpen}
      onLink={canLink ? handleLink : undefined}
      onAddToCanvas={
        flags.spatialCanvas
          ? (similar, canvas) => void handleAddToCanvas(similar, canvas)
          : undefined
      }
    />
  )
}

/**
 * Tag suggestions for a note that has no tags yet. Dismissing them holds for
 * this note until the page moves to another one.
 */
export function NoteSuggestedTags({
  noteId,
  tags,
  disabled
}: {
  noteId: string
  tags: readonly string[]
  disabled: boolean
}): React.JSX.Element | null {
  const { t } = useT('notes')
  const { updateNote } = useNoteMutations()
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const visible = tags.length === 0 && dismissedFor !== noteId
  const suggestions = useTagSuggestions(noteId, { enabled: visible })

  const handleAccept = useCallback(
    async (tag: string) => {
      if (disabled) return
      if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return
      try {
        await updateNote.mutateAsync({ id: noteId, tags: [...tags, tag] })
      } catch (err) {
        log.error('Failed to add suggested tag:', err)
        toast.error(extractErrorMessage(err, t('suggestedTags.failed')))
      }
    },
    [disabled, noteId, tags, updateNote, t]
  )

  if (!visible) return null
  return (
    <SuggestedTagsRow
      suggestions={suggestions}
      onAccept={(tag) => void handleAccept(tag)}
      onDismiss={() => setDismissedFor(noteId)}
      disabled={disabled}
    />
  )
}
