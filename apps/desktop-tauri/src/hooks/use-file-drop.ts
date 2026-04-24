import { useState, useCallback, useRef } from 'react'
import { isSupported, getExtension, getAllSupportedExtensions } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:useFileDrop')

const DRAG_TIMEOUT_MS = 150

interface FileDropResult {
  validPaths: string[]
  skippedCount: number
}

interface UseFileDropOptions {
  onDrop: (paths: string[]) => Promise<void> | void
}

interface UseFileDropReturn {
  isDraggingFiles: boolean
  dropHandlers: {
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

function hasExternalFiles(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
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

  // TODO: Tauri drag-drop path resolution. In Electron this used
  // webUtils.getPathForFile(); Tauri exposes paths via onFileDropEvent at the
  // window level instead. For now, fall back to the File.path extension which
  // some browsers populate.
  return files.map((f) => ({
    path: (f as File & { path?: string }).path || '',
    name: f.name
  }))
}

export function useFileDrop({ onDrop }: UseFileDropOptions): UseFileDropReturn {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasExternalFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'

    setIsDraggingFiles(true)

    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setIsDraggingFiles(false), DRAG_TIMEOUT_MS)
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

      if (!hasExternalFiles(e)) return

      const resolved = resolveDroppedFiles(e.dataTransfer.files)
      const { validPaths, skippedCount } = extractValidPaths(resolved)

      if (validPaths.length === 0) {
        if (skippedCount > 0) {
          const exts = getAllSupportedExtensions().join(', ')
          log.warn('No supported files in drop', { skippedCount, supported: exts })
        }
        return
      }

      log.info('Files dropped', { count: validPaths.length, skipped: skippedCount })
      void onDrop(validPaths)
    },
    [onDrop]
  )

  return {
    isDraggingFiles,
    dropHandlers: {
      onDragOver: handleDragOver,
      onDrop: handleDrop
    }
  }
}
