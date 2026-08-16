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
  validPaths: string[]
  skippedCount: number
}

interface UseFileDropOptions {
  onDrop: (paths: string[], targetFolder: string) => Promise<void> | void
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

export function extractValidPaths(files: Array<{ path: string; name: string }>): FileDropResult {
  const validPaths: string[] = []
  let skippedCount = 0

  for (const file of files) {
    const nameForExt = file.path || file.name

    if (!nameForExt) {
      skippedCount++
      continue
    }

    const ext = getExtension(nameForExt)
    if (!ext || !isSupported(ext)) {
      skippedCount++
      continue
    }

    if (!file.path) {
      log.warn('Supported file missing filesystem path', { name: file.name, ext })
      skippedCount++
      continue
    }

    validPaths.push(file.path)
  }

  return { validPaths, skippedCount }
}

function resolveDroppedFiles(fileList: FileList): Array<{ path: string; name: string }> {
  const files = Array.from(fileList)

  try {
    const paths = window.api.getFileDropPaths(files)
    return files.map((f, i) => ({ path: paths[i] || '', name: f.name }))
  } catch (err) {
    log.warn('webUtils.getPathForFile unavailable, falling back to file.path', err)
    return files.map((f) => ({
      path: (f as File & { path?: string }).path || '',
      name: f.name
    }))
  }
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
      const resolved = resolveDroppedFiles(e.dataTransfer.files)
      const { validPaths, skippedCount } = extractValidPaths(resolved)

      if (validPaths.length === 0) {
        if (skippedCount > 0) {
          const exts = getAllSupportedExtensions().join(', ')
          log.warn('No supported files in drop', { skippedCount, supported: exts })
        }
        return
      }

      log.info('Files dropped', {
        count: validPaths.length,
        skipped: skippedCount,
        targetFolder: targetFolder || '<vault root>'
      })
      void onDrop(validPaths, targetFolder)
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
