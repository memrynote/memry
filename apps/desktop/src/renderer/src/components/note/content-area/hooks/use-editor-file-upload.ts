/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

import { useCallback, useEffect } from 'react'
import { notesService } from '@/services/notes-service'
import { createFileBlockContent } from '../file-block'
import type { DropTarget } from '../drop-target-utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:EditorFileUpload')

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
  const uploadFile = useCallback(async (file: File): Promise<string> => {
    const currentNoteId = noteIdRef.current
    if (!currentNoteId) {
      throw new Error('Cannot upload: no note selected')
    }

    const result = await notesService.uploadAttachment(currentNoteId, file)
    if (!result.success || !result.path) {
      throw new Error(result.error || 'Upload failed')
    }

    return result.path
  }, [noteIdRef])

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
        }
      }

      return true
    },
    [noteId, editable, editor, dropTarget, onDragReset]
  )

  // Capture-phase drop handler to intercept before BlockNote
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const captureDropHandler = (e: DragEvent): void => {
      const files = Array.from(e.dataTransfer?.files || [])
      const hasNonImageFiles = files.some((f) => !isImageFile(f))

      if (hasNonImageFiles) {
        e.preventDefault()
        e.stopPropagation()

        void handleNonImageDrop({
          ...e,
          dataTransfer: e.dataTransfer,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
          currentTarget: container
        } as unknown as React.DragEvent)
      }
    }

    container.addEventListener('drop', captureDropHandler, { capture: true })

    return () => {
      container.removeEventListener('drop', captureDropHandler, { capture: true })
    }
  }, [handleNonImageDrop, containerRef])

  return { uploadFile, handleNonImageDrop }
}
