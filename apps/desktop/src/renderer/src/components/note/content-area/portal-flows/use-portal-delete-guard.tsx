/**
 * The delete guard. A block another note shows through a portal should not
 * vanish from there by accident, so:
 *
 * - a delete from the block menu asks first (`requestBlockRemoval`) when any
 *   deleted block has a host, and says so out loud;
 * - a delete by keyboard cannot ask, so the editor's change stream is watched
 *   and a toast with Undo follows.
 *
 * A block used nowhere else deletes silently, as before.
 *
 * @module note/content-area/portal-flows/use-portal-delete-guard
 */

import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { toast } from 'sonner'
import { stripAnchor } from '@memry/shared/portal-block'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import type { EditorSchema } from '../editor-schema'
import { getPortalUsage } from './portal-api'
import { findBlockHosts, guardBlockText, type GuardBlock } from './portal-delete-guard'
import { usePortalDeleteConfirm } from './portal-delete-dialog'

const log = createLogger('PortalDeleteGuard')

const UNDO_TOAST_MS = 10_000

type Editor = EditorSchema['BlockNoteEditor']

export interface PortalDeleteGuardOptions {
  editor: Editor
  noteId: string | undefined
  /** The note's name, shown as the "(source)" row. */
  noteTitle: string
  /**
   * Inside a portal window: hide these blocks from the portal instead of
   * deleting them. Omitted outside a portal, which removes that answer.
   */
  removeFromPortal?: (blockIds: readonly string[]) => void
}

export function usePortalDeleteGuard({
  editor,
  noteId,
  noteTitle,
  removeFromPortal
}: PortalDeleteGuardOptions): {
  requestBlockRemoval: (blockIds: readonly string[]) => Promise<void>
  dialog: ReactElement
} {
  const { t } = useT('notes')
  const { confirm, dialog } = usePortalDeleteConfirm()
  // Blocks the menu path deleted after asking; the change watcher must not
  // answer the same delete with a toast.
  const confirmedRef = useRef(new Set<string>())

  const removeBlocks = useCallback(
    (blocks: readonly GuardBlock[]) => {
      for (const block of blocks) confirmedRef.current.add(block.id)
      editor.removeBlocks(blocks.map((block) => block.id))
    },
    [editor]
  )

  const requestBlockRemoval = useCallback(
    async (blockIds: readonly string[]): Promise<void> => {
      const blocks = blockIds.flatMap((id) => {
        const block = editor.getBlock(id)
        return block ? [block as unknown as GuardBlock] : []
      })
      if (blocks.length === 0) return

      let hosts: Awaited<ReturnType<typeof findBlockHosts>> = []
      if (noteId) {
        try {
          hosts = await findBlockHosts(noteId, blocks, getPortalUsage)
        } catch (err) {
          // A failed lookup must not make delete unusable; the toast path
          // below is blind too, so say so in the log.
          log.error('Portal usage lookup failed before delete', err)
        }
      }
      if (hosts.length === 0) {
        removeBlocks(blocks)
        return
      }

      const choice = await confirm({
        subject: 'block',
        title: stripAnchor(guardBlockText(blocks[0])).trim(),
        sourceTitle: noteTitle,
        hosts,
        canRemoveHere: removeFromPortal !== undefined
      })
      if (choice === 'everywhere') removeBlocks(blocks)
      else if (choice === 'here') removeFromPortal?.(blocks.map((block) => block.id))
    },
    [editor, noteId, noteTitle, removeFromPortal, confirm, removeBlocks]
  )

  const onKeyboardDelete = useCallback(
    async (removed: readonly GuardBlock[]): Promise<void> => {
      if (!noteId) return
      const unconfirmed = removed.filter((block) => !confirmedRef.current.delete(block.id))
      if (unconfirmed.length === 0) return
      let hosts: Awaited<ReturnType<typeof findBlockHosts>>
      try {
        hosts = await findBlockHosts(noteId, unconfirmed, getPortalUsage)
      } catch (err) {
        log.error('Portal usage lookup failed after delete', err)
        return
      }
      if (hosts.length === 0) return
      toast(t('portalFlows.deleteGuard.undoToast', { count: hosts.length }), {
        duration: UNDO_TOAST_MS,
        action: { label: t('portalFlows.deleteGuard.undo'), onClick: () => editor.undo() }
      })
    },
    [editor, noteId, t]
  )

  useEffect(() => {
    if (!noteId) return
    // Local edits only: a delete that arrived from sync was somebody else's
    // call, made in a note that owns the block.
    return editor.onChange((_editor, context) => {
      const removed = context
        .getChanges()
        .flatMap((change) =>
          change.type === 'delete' && change.source.type === 'local'
            ? [change.block as unknown as GuardBlock]
            : []
        )
      if (removed.length > 0) void onKeyboardDelete(removed)
    }, false)
  }, [editor, noteId, onKeyboardDelete])

  return { requestBlockRemoval, dialog }
}
