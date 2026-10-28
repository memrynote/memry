import { useState, useCallback, useRef } from 'react'
import { isSupported, getExtension, getAllSupportedExtensions } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'
import { droppedNames, uriFileName, type DroppedFiles } from '@/lib/drop-stage'

const log = createLogger('Hook:useFileDrop')

const DRAG_TIMEOUT_MS = 150

/**
 * Marks an element as the destination for a file dropped anywhere inside it.
 * The value is a vault-relative folder path, `''` for the vault root — the same
 * shape `importFiles` and the folder APIs take.
 */
export const FILE_DROP_FOLDER_ATTR = 'data-file-drop-folder'

interface FileDropResult {
  valid: DroppedFiles
  skippedCount: number
}

interface UseFileDropOptions {
  /** The dropped files the app can import. They have no path: stage them (`withStagedFiles`). */
  onDrop: (dropped: DroppedFiles, targetFolder: string) => Promise<void> | void
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

/**
 * Whether a drag may carry files from the OS. WebKitGTK offers a file drag as `text/uri-list`
 * alone, and the list is unreadable until the drop, so a dragged web link counts here too; the
 * drop then reads the list and leaves a link alone.
 */
function mayCarryFiles(e: React.DragEvent): boolean {
  const { types } = e.dataTransfer
  return types.includes('Files') || types.includes('text/uri-list')
}

/** The `file://` entries of the drag's URI list. */
function fileUris(data: DataTransfer): string[] {
  return data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('file:'))
}

/** The files of a drop, as `File` objects or, on WebKitGTK, as URIs; `null` when it has none. */
export function readDroppedFiles(data: DataTransfer): DroppedFiles | null {
  const files = Array.from(data.files)
  if (files.length > 0) return { files }
  const uris = fileUris(data)
  return uris.length > 0 ? { uris } : null
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

function isSupportedName(name: string): boolean {
  const ext = getExtension(name)
  return Boolean(ext && isSupported(ext))
}

export function extractValidFiles(dropped: DroppedFiles): FileDropResult {
  const valid: DroppedFiles =
    'files' in dropped
      ? { files: dropped.files.filter((file) => isSupportedName(file.name)) }
      : { uris: dropped.uris.filter((uri) => isSupportedName(uriFileName(uri))) }
  return {
    valid,
    skippedCount: droppedNames(dropped).length - droppedNames(valid).length
  }
}

export function useFileDrop({ onDrop }: UseFileDropOptions): UseFileDropReturn {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!mayCarryFiles(e)) return
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
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      setIsDraggingFiles(false)
      setDropFolder(null)

      // Unclaimed, a dropped web link goes to the browser (`external-link-guard`).
      const dropped = readDroppedFiles(e.dataTransfer)
      if (!dropped) return
      e.preventDefault()
      e.stopPropagation()

      // Read the destination off the element under the pointer, not off the
      // sidebar selection — where the file lands is where it was dropped.
      const targetFolder = resolveDropFolder(e.target)
      const { valid, skippedCount } = extractValidFiles(dropped)
      const count = droppedNames(valid).length

      if (count === 0) {
        if (skippedCount > 0) {
          const exts = getAllSupportedExtensions().join(', ')
          log.warn('No supported files in drop', { skippedCount, supported: exts })
        }
        return
      }

      log.info('Files dropped', {
        count,
        skipped: skippedCount,
        targetFolder: targetFolder || '<vault root>'
      })
      void onDrop(valid, targetFolder)
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
