/**
 * Data and actions behind the portal picker: note search through the existing
 * search IPC, block search through `portals:search`, and what picking a row
 * writes into the note.
 *
 * @module note/content-area/portal-flows/use-portal-picker
 */

import { useCallback, useMemo, useRef } from 'react'
import { SuggestionMenu } from '@blocknote/core/extensions'
import { toast } from 'sonner'
import type { PortalDefinition } from '@memry/shared/portal-block'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { notesService } from '@/services/notes-service'
import type { EditorSchema } from '../editor-schema'
import { updatePortalDefinition, type PortalEditorLike } from '../portal/portal-definition'
import { searchPortalBlocks, stampPortalAnchor } from './portal-api'
import { blockDefinition, insertPortalBlock, noteDefinition } from './portal-insert'
import { PORTAL_PICKER_TRIGGER } from './portal-slash-items'
import {
  PICKER_BLOCK_LIMIT,
  PICKER_NOTE_LIMIT,
  buildPortalPickerList,
  type PortalPickerBlock,
  type PortalPickerItem,
  type PortalPickerNote
} from './portal-picker-model'

const log = createLogger('PortalPicker')

/** Notes to offer: ranked search hits for a query, the recently edited ones without. */
async function loadNotes(query: string): Promise<PortalPickerNote[]> {
  if (query.trim() === '') {
    const { notes } = await notesService.list({ limit: PICKER_NOTE_LIMIT, sortBy: 'modified' })
    return notes.map((note) => ({
      noteId: note.id,
      title: note.title,
      path: note.path,
      emoji: note.emoji
    }))
  }
  const response = await window.api.search.query({
    text: query,
    types: ['note'],
    noteFileTypes: ['markdown'],
    limit: PICKER_NOTE_LIMIT
  })
  return response.groups.flatMap((group) =>
    group.results.flatMap((hit) =>
      hit.metadata.type === 'note'
        ? [
            {
              noteId: hit.id,
              title: hit.title,
              path: hit.metadata.path,
              emoji: hit.metadata.emoji
            }
          ]
        : []
    )
  )
}

async function loadBlocks(query: string): Promise<PortalPickerBlock[]> {
  const text = query.trim()
  if (text === '') return []
  const { results } = await searchPortalBlocks({ text, limit: PICKER_BLOCK_LIMIT * 2 })
  return results.map((hit) => ({
    noteId: hit.noteId,
    noteTitle: hit.title,
    parentText: hit.parentText,
    blockId: hit.blockId,
    anchor: hit.anchor,
    text: hit.text
  }))
}

export function usePortalPicker(
  editor: EditorSchema['BlockNoteEditor'],
  hostNoteId: string | undefined,
  ancestry: readonly string[]
) {
  const { t } = useT('notes')
  const ancestryRef = useRef(ancestry)
  // Set while the picker is choosing a new target for an existing portal.
  const replacingRef = useRef<{ portalBlockId: string; tempBlockId: string } | null>(null)
  ancestryRef.current = ancestry

  const getItems = useCallback(
    async (query: string): Promise<PortalPickerItem[]> => {
      // One half failing (search index rebuilding) must not hide the other.
      const [notes, blocks] = await Promise.all([
        loadNotes(query).catch((err: unknown) => {
          log.error('Note search failed', err)
          return []
        }),
        loadBlocks(query).catch((err: unknown) => {
          log.error('Block search failed', err)
          return []
        })
      ])
      return buildPortalPickerList({
        notes,
        blocks,
        hostNoteId,
        ancestry: ancestryRef.current,
        query,
        activeBlockId: editor.getTextCursorPosition().block.id
      })
    },
    [editor, hostNoteId]
  )

  const pick = useCallback(
    async (item: PortalPickerItem): Promise<void> => {
      let definition: PortalDefinition
      if (item.kind === 'create') {
        try {
          const created = await notesService.create({ title: item.title, content: '' })
          if (!created.success || !created.note) throw new Error(created.error)
          definition = noteDefinition(created.note.id)
        } catch (err) {
          log.error('Failed to create a note for a portal', err)
          toast.error(extractErrorMessage(err, t('portalFlows.picker.createFailed')))
          return
        }
      } else if (item.kind === 'note') {
        definition = noteDefinition(item.noteId)
      } else {
        try {
          // A block is addressed by its anchor, which exists only once stamped.
          const anchor =
            item.anchor ??
            (await (async () => {
              const stamped = await stampPortalAnchor(item.noteId, item.blockId)
              if (!stamped.success) throw new Error(stamped.reason)
              return stamped.anchor
            })())
          definition = blockDefinition(item.noteId, anchor)
        } catch (err) {
          log.error('Failed to stamp portal anchor', err)
          toast.error(extractErrorMessage(err, t('portalFlows.picker.stampFailed')))
          return
        }
      }
      // A pick made where the replace flow left its empty paragraph retargets
      // the portal; anywhere else the picker was abandoned, and this is an insert.
      const replacing = replacingRef.current
      replacingRef.current = null
      if (replacing && editor.getTextCursorPosition().block.id === replacing.tempBlockId) {
        const changed = updatePortalDefinition(
          editor as unknown as PortalEditorLike,
          replacing.portalBlockId,
          { target: definition.target }
        )
        editor.removeBlocks([replacing.tempBlockId])
        if (!changed) toast.error(t('portalFlows.picker.retargetFailed'))
        return
      }
      insertPortalBlock(editor, definition)
    },
    [editor, t]
  )

  /** Open the picker to choose a new target for the portal block `portalBlockId`. */
  const startReplace = useCallback(
    (portalBlockId: string): void => {
      const [temp] = editor.insertBlocks([{ type: 'paragraph' }], portalBlockId, 'after')
      editor.setTextCursorPosition(temp, 'start')
      replacingRef.current = { portalBlockId, tempBlockId: temp.id }
      editor
        .getExtension(SuggestionMenu)
        ?.openSuggestionMenu(PORTAL_PICKER_TRIGGER, { deleteTriggerCharacter: true })
    },
    [editor]
  )

  return useMemo(() => ({ getItems, pick, startReplace }), [getItems, pick, startReplace])
}
