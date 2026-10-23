/**
 * Option+drag of a block handle onto another open note drops a portal to the
 * block instead of moving or copying its content.
 *
 * HTML5 drag-and-drop gives the drop target no way to tell which editor the
 * drag started in, so each editor's layer records its own drags: a `dragstart`
 * from a handle in this editor's side menu names the hovered block as the
 * source. The target editor then claims an Option-held drop from another note.
 * The drag stays a plain drag everywhere else; BlockNote's own handling is only
 * pre-empted for the Option drop.
 *
 * @module note/content-area/portal-flows/use-portal-block-drop
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import type { EditorView } from '@tiptap/pm/view'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { EditorSchema } from '../editor-schema'
import { stampPortalAnchor } from './portal-api'
import { blockDefinition, findPortalCycle, insertPortalBlock } from './portal-insert'

const log = createLogger('PortalBlockDrop')

type Editor = EditorSchema['BlockNoteEditor']

interface ActiveDrag {
  noteId: string
  blockId: string
}

// One drag at a time exists per window, and it spans two editors' layers.
let activeDrag: ActiveDrag | null = null

/** The block container under a point, or null when the point is outside the document. */
function blockIdAtPoint(editor: Editor, x: number, y: number): string | null {
  const view = (editor as unknown as { prosemirrorView?: EditorView }).prosemirrorView
  const hit = view?.posAtCoords({ left: x, top: y })
  if (!view || !hit) return null
  const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type.name === 'blockContainer') return String(node.attrs.id)
  }
  return null
}

export function usePortalBlockDrop({
  editor,
  noteId,
  editable,
  ancestry,
  hoveredBlockId
}: {
  editor: Editor
  noteId: string | undefined
  editable: boolean
  ancestry: readonly string[]
  /** The block the side menu is on right now; the source of a handle drag. */
  hoveredBlockId: string | undefined
}): void {
  const { t } = useT('notes')

  useEffect(() => {
    if (!noteId) return
    const sourceNoteId = noteId

    const onDragStart = (event: DragEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || !hoveredBlockId) return
      if (!target.closest('.bn-side-menu')) return
      // The portal element mounts inside this editor's own container.
      if (!editor.domElement?.closest('.bn-container')?.contains(target)) return
      activeDrag = { noteId: sourceNoteId, blockId: hoveredBlockId }
    }
    // After the drop handlers have run.
    const onDragEnd = (): void => {
      setTimeout(() => {
        activeDrag = null
      }, 0)
    }

    const claims = (event: DragEvent): ActiveDrag | null => {
      const drag = activeDrag
      if (!drag || !event.altKey || !editable || drag.noteId === sourceNoteId) return null
      return drag
    }

    const onDragOver = (event: DragEvent): void => {
      if (!claims(event) || !event.dataTransfer) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (event: DragEvent): void => {
      const drag = claims(event)
      if (!drag) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const targetBlockId = blockIdAtPoint(editor, event.clientX, event.clientY)
      void dropPortal(drag, targetBlockId)
    }

    const dropPortal = async (drag: ActiveDrag, targetBlockId: string | null): Promise<void> => {
      if (findPortalCycle(sourceNoteId, ancestry, drag.noteId)) {
        toast.error(t('portalFlows.insert.cycle'))
        return
      }
      try {
        const stamped = await stampPortalAnchor(drag.noteId, drag.blockId)
        if (!stamped.success) throw new Error(stamped.reason)
        if (targetBlockId) editor.setTextCursorPosition(targetBlockId, 'end')
        insertPortalBlock(editor, blockDefinition(drag.noteId, stamped.anchor))
      } catch (err) {
        log.error('Failed to drop a portal', err)
        toast.error(extractErrorMessage(err, t('portalFlows.picker.stampFailed')))
      }
    }

    const root = editor.domElement
    document.addEventListener('dragstart', onDragStart, true)
    document.addEventListener('dragend', onDragEnd, true)
    root?.addEventListener('dragover', onDragOver, true)
    root?.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragstart', onDragStart, true)
      document.removeEventListener('dragend', onDragEnd, true)
      root?.removeEventListener('dragover', onDragOver, true)
      root?.removeEventListener('drop', onDrop, true)
    }
  }, [editor, noteId, editable, ancestry, hoveredBlockId, t])
}
