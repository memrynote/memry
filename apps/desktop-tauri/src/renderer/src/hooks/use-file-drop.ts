import { useState, useCallback, useRef } from 'react'
import { isSupported, getExtension, getAllSupportedExtensions } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:useFileDrop')

const DRAG_TIMEOUT_MS = 150

/**
 * Marks an element as the destination for a file dropped anywhere inside it.
 * The value is a vault-relative folder path, `''` for the vault root — the same
 * shape `importFiles` and the folder APIs take.
 */
export const FILE_DROP_FOLDER_ATTR = 'data-file-drop-folder'

interface FileDropResult {
  validFiles: File[]
  skippedCount: number
}

interface UseFileDropOptions {
  /** The dropped files the app can import. They have no path: stage them (`withStagedFiles`). */
  onDrop: (files: File[], targetFolder: string) => Promise<void> | void
}

interface UseFileDropReturn {
  isDraggingFiles: boolean
  /** Folder the pointer is currently over, or null when no file drag is active. */
  dropFolder: string | null
  dropHandlers: {
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

function hasExternalFiles(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

/**
 * Innermost declared drop folder at `target`, walking up the tree.
 *
 * The pointer lands on whatever leaf is under it — a label span, an icon — so
 * the row that owns the destination is always an ancestor. Anything outside a
 * declared zone falls back to the vault root rather than to the last selection.
 */
export function resolveDropFolder(target: EventTarget | null): string {
  if (!(target instanceof Element)) return ''
  return target.closest(`[${FILE_DROP_FOLDER_ATTR}]`)?.getAttribute(FILE_DROP_FOLDER_ATTR) ?? ''
}

export function extractValidFiles(files: File[]): FileDropResult {
  const validFiles: File[] = []
  let skippedCount = 0

  for (const file of files) {
    const ext = getExtension(file.name)
    if (ext && isSupported(ext)) {
      validFiles.push(file)
    } else {
      skippedCount++
    }
  }

  return { validFiles, skippedCount }
}

export function useFileDrop({ onDrop }: UseFileDropOptions): UseFileDropReturn {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasExternalFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'

    setIsDraggingFiles(true)
    setDropFolder(resolveDropFolder(e.target))

    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setIsDraggingFiles(false)
      setDropFolder(null)
    }, DRAG_TIMEOUT_MS)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      setIsDraggingFiles(false)
      setDropFolder(null)

      if (!hasExternalFiles(e)) return

      // Read the destination off the element under the pointer, not off the
      // sidebar selection — where the file lands is where it was dropped.
      const targetFolder = resolveDropFolder(e.target)
      const { validFiles, skippedCount } = extractValidFiles(Array.from(e.dataTransfer.files))

      if (validFiles.length === 0) {
        if (skippedCount > 0) {
          const exts = getAllSupportedExtensions().join(', ')
          log.warn('No supported files in drop', { skippedCount, supported: exts })
        }
        return
      }

      log.info('Files dropped', {
        count: validFiles.length,
        skipped: skippedCount,
        targetFolder: targetFolder || '<vault root>'
      })
      void onDrop(validFiles, targetFolder)
    },
    [onDrop]
  )

  return {
    isDraggingFiles,
    dropFolder,
    dropHandlers: {
      onDragOver: handleDragOver,
      onDrop: handleDrop
    }
  }
}
