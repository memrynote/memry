/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect } from 'react'
import { notesService } from '@/services/notes-service'
import { createFileBlockContent } from '../file-block'
import type { DropTarget } from '../drop-target-utils'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toMemryFileUrl } from '@/lib/memry-file-url'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'

const log = createLogger('Hook:EditorFileUpload')

// A rejected drop used to be log-only: the file simply never appeared and the
// user was left guessing. The reasons are ones users hit (over the size cap, an
// extension the vault does not accept), so they have to be said out loud.
function reportUploadFailure(error: unknown): void {
  const t = getI18n().getFixedT(null, 'notes')
  toast.error(extractErrorMessage(error, t('editor.upload.failed')))
}

const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml'
]

export function isImageFile(file: File): boolean {
  return IMAGE_TYPES.includes(file.type.toLowerCase())
}

interface EditorFileUploadParams {
  editor: any
  noteId?: string
  editable?: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  noteIdRef: React.RefObject<string | undefined>
  dropTarget: DropTarget | null
  onDragReset: () => void
}

interface EditorFileUploadResult {
  uploadFile: (file: File) => Promise<string>
  handleNonImageDrop: (e: React.DragEvent) => Promise<boolean>
  handleInternalItemDrop: (dataTransfer: DataTransfer) => Promise<void>
}

export function useEditorFileUpload({
  editor,
  noteId,
  editable,
  containerRef,
  noteIdRef,
  dropTarget,
  onDragReset
}: EditorFileUploadParams): EditorFileUploadResult {
  const uploadFile = useCallback(
    async (file: File): Promise<string> => {
      const currentNoteId = noteIdRef.current
      if (!currentNoteId) {
        throw new Error('Cannot upload: no note selected')
      }

      const result = await notesService.uploadAttachment(currentNoteId, file)
      if (!result.success || !result.path) {
        throw new Error(result.error || 'Upload failed')
      }

      return result.path
    },
    [noteIdRef]
  )

  const handleNonImageDrop = useCallback(
    async (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files)
      const nonImageFiles = files.filter((f) => !isImageFile(f))

      if (nonImageFiles.length === 0) {
        return false
      }

      e.preventDefault()
      e.stopPropagation()

      const insertTarget = dropTarget
      onDragReset()

      if (!noteId) {
        log.warn('Cannot upload attachment: no noteId provided')
        return true
      }

      if (!editable) return true

      let referenceBlockId: string
      let placement: 'before' | 'after' = 'after'

      if (insertTarget) {
        referenceBlockId = insertTarget.blockId
        placement = insertTarget.position
      } else {
        referenceBlockId = editor.getTextCursorPosition().block.id
      }

      for (const file of files) {
        try {
          const result = await notesService.uploadAttachment(noteId, file)

          if (!result.success) {
            log.error('Upload failed', result.error)
            trackRendererError(
              'editor_attachment_upload',
              new Error(result.error || 'Upload failed')
            )
            reportUploadFailure(result.error)
            continue
          }

          if (result.type === 'image' && result.path) {
            editor.insertBlocks(
              [
                {
                  type: 'image',
                  props: {
                    url: result.path,
                    caption: result.name || file.name,
                    previewWidth: 600
                  }
                }
              ],
              referenceBlockId,
              placement
            )
          } else if (result.path) {
            editor.insertBlocks(
              [
                createFileBlockContent({
                  url: result.path,
                  name: result.name || file.name,
                  size: result.size || file.size,
                  mimeType: result.mimeType || file.type
                })
              ],
              referenceBlockId,
              placement
            )
          }

          placement = 'after'
        } catch (error) {
          log.error('Failed to upload file', file.name, error)
          trackRendererError('editor_attachment_upload', error)
          reportUploadFailure(error)
        }
      }

      return true
    },
    [noteId, editable, editor, dropTarget, onDragReset]
  )

  // Embed a file-type item dragged out of the left sidebar. Unlike an OS file
  // drop, the bytes already live in the vault, so we reference the item by its
  // own path (memry-file:// URL) instead of copying into attachments/.
  const handleInternalItemDrop = useCallback(
    async (dataTransfer: DataTransfer): Promise<void> => {
      const itemId = dataTransfer.getData(MEMRY_NOTE_DRAG_MIME)
      if (!itemId) return

      const insertTarget = dropTarget
      onDragReset()

      if (!editable) return

      let referenceBlockId: string
      let placement: 'before' | 'after' = 'after'
      if (insertTarget) {
        referenceBlockId = insertTarget.blockId
        placement = insertTarget.position
      } else {
        referenceBlockId = editor.getTextCursorPosition().block.id
      }

      try {
        const file = await notesService.getFile(itemId)
        if (!file?.absolutePath) {
          log.warn('Cannot embed dropped item: no file path', itemId)
          return
        }

        const url = toMemryFileUrl(file.absolutePath)
        const name = file.title || 'file'
        const mimeType = file.mimeType || ''

        if (file.fileType === 'image' || mimeType.startsWith('image/')) {
          editor.insertBlocks(
            [{ type: 'image', props: { url, caption: name, previewWidth: 600 } }],
            referenceBlockId,
            placement
          )
        } else {
          editor.insertBlocks(
            [createFileBlockContent({ url, name, size: file.fileSize ?? 0, mimeType })],
            referenceBlockId,
            placement
          )
        }
      } catch (error) {
        log.error('Failed to embed dropped item', itemId, error)
      }
    },
    [editable, editor, dropTarget, onDragReset]
  )

  // Capture-phase drop handler to intercept before BlockNote
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const captureDropHandler = (e: DragEvent): void => {
      const dataTransfer = e.dataTransfer
      if (!dataTransfer) return

      const files = Array.from(dataTransfer.files || [])
      const hasNonImageFiles = files.some((f) => !isImageFile(f))

      if (hasNonImageFiles) {
        e.preventDefault()
        e.stopPropagation()

        void handleNonImageDrop({
          ...e,
          dataTransfer,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
          currentTarget: container
        } as unknown as React.DragEvent)
        return
      }

      // Internal file-type sidebar item (no OS files on the drag).
      if (files.length === 0 && dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) {
        e.preventDefault()
        e.stopPropagation()
        void handleInternalItemDrop(dataTransfer)
      }
    }

    container.addEventListener('drop', captureDropHandler, { capture: true })

    return () => {
      container.removeEventListener('drop', captureDropHandler, { capture: true })
    }
  }, [handleNonImageDrop, handleInternalItemDrop, containerRef])

  return { uploadFile, handleNonImageDrop, handleInternalItemDrop }
}
