import { useEffect } from 'react'
import { SIDEBAR_REVEAL_FOLDER_EVENT } from '@/components/note/note-breadcrumb'
import { useTree } from '@/components/kibo-ui/tree'
import { FolderIconButton } from '@/components/folder-icon-button'

// ============================================================================
// TreeFolderIcon — reads expand state from TreeProvider context
// ============================================================================

export function TreeFolderIcon({
  nodeId,
  hasChildren,
  ...props
}: Omit<React.ComponentProps<typeof FolderIconButton>, 'isExpanded'> & {
  nodeId: string
}) {
  const { expandedIds, toggleExpanded } = useTree()
  const isExpanded = expandedIds.has(nodeId)

  return (
    <FolderIconButton
      {...props}
      isExpanded={isExpanded}
      hasChildren={hasChildren}
      onToggleExpand={() => toggleExpanded(nodeId)}
    />
  )
}

// ============================================================================
// RevealHandler — expands folders to reveal a specific note
// ============================================================================

interface RevealHandlerProps {
  pendingRevealNoteId: string | null
  noteMap: Map<string, { path: string }>
  onReveal: (noteId: string) => void
  onClear: () => void
}

export function RevealHandler({
  pendingRevealNoteId,
  noteMap,
  onReveal,
  onClear
}: RevealHandlerProps) {
  const { expandNode } = useTree()

  useEffect(() => {
    if (!pendingRevealNoteId) return

    const note = noteMap.get(pendingRevealNoteId)
    if (!note) {
      onClear()
      return
    }

    const pathParts = note.path.split('/')
    pathParts.pop()

    if (pathParts.length > 1) {
      const folderParts = pathParts.slice(1)
      let currentPath = ''
      for (const part of folderParts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        expandNode(`folder-${currentPath}`)
      }
    }

    setTimeout(() => {
      onReveal(pendingRevealNoteId)
    }, 50)
  }, [pendingRevealNoteId, noteMap, expandNode, onReveal, onClear])

  return null
}

// ============================================================================
// FolderRevealHandler — listens for breadcrumb folder clicks
// ============================================================================

export function FolderRevealHandler() {
  const { expandNode } = useTree()

  useEffect(() => {
    const handleRevealFolder = (event: CustomEvent<{ folderPath: string }>) => {
      const { folderPath } = event.detail
      if (!folderPath) return

      try {
        localStorage.setItem('sidebar-section-collections-expanded', 'true')
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'sidebar-section-collections-expanded',
            newValue: 'true'
          })
        )
      } catch {
        // Ignore localStorage errors
      }

      const parts = folderPath.split('/')
      let currentPath = ''
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        expandNode(`folder-${currentPath}`)
      }

      setTimeout(() => {
        const nodeId = `folder-${folderPath}`
        const element = document.querySelector(`[data-tree-node-id="${nodeId}"]`)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          element.classList.add('bg-accent')
          setTimeout(() => element.classList.remove('bg-accent'), 2000)
        }
      }, 100)
    }

    window.addEventListener(SIDEBAR_REVEAL_FOLDER_EVENT, handleRevealFolder as EventListener)
    return () => {
      window.removeEventListener(SIDEBAR_REVEAL_FOLDER_EVENT, handleRevealFolder as EventListener)
    }
  }, [expandNode])

  return null
}

// ============================================================================
// TreeActionsExposer — bridges tree context to parent ref
// ============================================================================

export type TreeActionsHandle = {
  collapseAll: () => void
  expandAll: () => void
  expandNode: (nodeId: string) => void
  expandNodes: (nodeIds: string[]) => void
}

export function TreeActionsExposer({
  actionsRef
}: {
  actionsRef: React.MutableRefObject<TreeActionsHandle | null>
}) {
  const { collapseAll, expandAll, expandNode, expandNodes } = useTree()

  useEffect(() => {
    actionsRef.current = { collapseAll, expandAll, expandNode, expandNodes }
    return () => {
      actionsRef.current = null
    }
  }, [collapseAll, expandAll, expandNode, expandNodes, actionsRef])

  return null
}
