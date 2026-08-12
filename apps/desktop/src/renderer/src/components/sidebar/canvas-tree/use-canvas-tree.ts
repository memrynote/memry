/**
 * Loads the two lists the canvas tree is built from and keeps them live.
 *
 * Canvases and folders are separate rows in separate tables, so they are
 * fetched together and replaced together: a folder row landing a tick after
 * its canvases would flash every one of them at the root before snapping back.
 *
 * @module components/sidebar/canvas-tree/use-canvas-tree
 */

import * as React from 'react'
import {
  canvasService,
  onCanvasCreated,
  onCanvasUpdated,
  onCanvasDeleted,
  type CanvasSummary
} from '@/services/canvas-service'
import {
  canvasFolderService,
  onCanvasFolderCreated,
  onCanvasFolderUpdated,
  onCanvasFolderDeleted,
  type CanvasFolder
} from '@/services/canvas-folder-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('SpatialCanvas')

/** The event shape the folder-updated subscription hands back, as far as this needs it. */
interface FolderUpdatedEvent {
  folder?: { path?: string }
  previousPath?: string
}

/**
 * The path change a folder-updated event describes, or `null` when the update
 * left the path alone (an icon change) or the event carried nothing.
 *
 * Typed permissively on purpose: this reads a payload that crosses IPC, and a
 * listener that threw here would take the refresh down with it.
 */
function folderPathChangeOf(
  event: FolderUpdatedEvent | undefined
): { from: string; to: string } | null {
  const from = event?.previousPath
  const to = event?.folder?.path
  if (!from || !to || from === to) return null
  return { from, to }
}

export interface CanvasTreeOptions {
  /**
   * A folder row changed path — renamed, or moved to another parent. Anything
   * keyed by folder path (expansion state) has to be re-keyed, or the folder the
   * user was working in collapses under them.
   */
  onFolderPathChanged?: (from: string, to: string) => void
}

export interface CanvasTreeData {
  canvases: CanvasSummary[]
  folders: CanvasFolder[]
  isLoading: boolean
  hasError: boolean
  refresh: () => Promise<void>
}

export function useCanvasTree({ onFolderPathChanged }: CanvasTreeOptions = {}): CanvasTreeData {
  const [canvases, setCanvases] = React.useState<CanvasSummary[]>([])
  const [folders, setFolders] = React.useState<CanvasFolder[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [hasError, setHasError] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const [canvasResult, folderResult] = await Promise.all([
        canvasService.list(),
        canvasFolderService.list()
      ])
      setCanvases(canvasResult.canvases)
      setFolders(folderResult.folders)
      setHasError(false)
    } catch (err) {
      log.error('Failed to load the canvas tree', err)
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // Held in a ref so a caller passing an inline closure cannot make the six
  // subscriptions tear down and re-attach on every render.
  const pathChangedRef = React.useRef(onFolderPathChanged)
  React.useEffect(() => {
    pathChangedRef.current = onFolderPathChanged
  }, [onFolderPathChanged])

  // All six events, because either half of the tree can change on its own: a
  // folder can be created, renamed or deleted with no canvas touched, and a
  // canvas can move between folders with no folder row touched.
  React.useEffect(() => {
    const unsubscribes = [
      onCanvasCreated(() => void refresh()),
      onCanvasUpdated(() => void refresh()),
      onCanvasDeleted(() => void refresh()),
      onCanvasFolderCreated(() => void refresh()),
      onCanvasFolderUpdated((event) => {
        const change = folderPathChangeOf(event)
        if (change) pathChangedRef.current?.(change.from, change.to)
        void refresh()
      }),
      onCanvasFolderDeleted(() => void refresh())
    ]
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [refresh])

  return { canvases, folders, isLoading, hasError, refresh }
}
