import { useEffect, useRef } from 'react'
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

/**
 * How long to keep waiting for a note that is not in the tree yet. A note
 * created a moment ago only lands once the list query refetches, so the reveal
 * has to outlive that round trip — but an id that will never arrive (a deleted
 * note, a stale event) must not pin the pending state forever.
 */
const REVEAL_WAIT_MS = 5000

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
  const expandedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingRevealNoteId) {
      expandedForRef.current = null
      return
    }

    const note = noteMap.get(pendingRevealNoteId)
    if (!note) {
      // Hold the request instead of dropping it: `noteMap` is a dependency, so
      // this effect re-runs the moment the note reaches the tree.
      const giveUp = setTimeout(onClear, REVEAL_WAIT_MS)
      return () => clearTimeout(giveUp)
    }

    // Once per request, not once per render. Creating a note re-renders the
    // sidebar several times over, and none of this effect's callbacks are
    // stable, so expanding on every run would re-open a folder the moment the
    // user collapses it.
    if (expandedForRef.current !== pendingRevealNoteId) {
      expandedForRef.current = pendingRevealNoteId

      // Note paths are vault-relative, so every segment before the filename
      // names a real folder — the same ids `buildTreeFromNotes` gives the folder
      // nodes. Dropping the first segment assumed a vault-root prefix that has
      // not existed since #1204: a note one folder down (`movies/Untitled.md`,
      // the common case) expanded nothing at all, and a deeper one expanded
      // folders by the wrong name.
      const folderParts = note.path.split('/')
      folderParts.pop()

      let currentPath = ''
      for (const part of folderParts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        expandNode(`folder-${currentPath}`)
      }
    }

    const revealTimeout = setTimeout(() => {
      onReveal(pendingRevealNoteId)
    }, 50)

    return () => clearTimeout(revealTimeout)
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
  renameNode: (oldNodeId: string, newNodeId: string) => void
}

export function TreeActionsExposer({
  actionsRef
}: {
  actionsRef: React.MutableRefObject<TreeActionsHandle | null>
}) {
  const { collapseAll, expandAll, expandNode, expandNodes, renameNode } = useTree()

  useEffect(() => {
    actionsRef.current = { collapseAll, expandAll, expandNode, expandNodes, renameNode }
    return () => {
      actionsRef.current = null
    }
  }, [collapseAll, expandAll, expandNode, expandNodes, renameNode, actionsRef])

  return null
}
