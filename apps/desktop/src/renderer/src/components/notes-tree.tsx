'use client'

import { useMemo, useCallback, useState, useRef, useEffect, type ReactNode } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView
} from '@/components/kibo-ui/tree'
import { useNoteTreeData } from '@/hooks/use-note-tree-data'
import { useNoteTreeActions } from '@/hooks/use-note-tree-actions'
import { NoteTreeDeleteDialog, NoteTreeTemplateSelector } from '@/components/note-tree-dialogs'
import { NotesTreeSkeleton, NotesTreeEmpty, NotesTreeError } from '@/components/note-tree-states'
import {
  TreeFolderIcon,
  RevealHandler,
  FolderRevealHandler,
  TreeActionsExposer,
  type TreeActionsHandle
} from '@/components/note-tree-internal'
import {
  getDisplayName,
  getFileIcon,
  collectAllFolderIds,
  type FolderNode
} from '@/components/notes-tree-utils'
import type { NoteListItem } from '@/hooks/use-notes-query'
import {
  Pencil,
  Trash2,
  ExternalLink,
  FolderOpen,
  FilePlus,
  FolderPlus,
  LayoutTemplate,
  LayoutGrid,
  X,
  Monitor,
  Smile
} from '@/lib/icons'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { shouldVirtualize } from '@/lib/virtualized-tree-utils'
import {
  VirtualizedNotesTree,
  type VirtualizedTreeActions
} from '@/components/virtualized-notes-tree'

// ============================================================================
// Main Component
// ============================================================================

interface NotesTreeActions {
  createNote: () => void
  createFolder: () => void
  collapseAll: () => void
  expandAll: () => void
}

interface NotesTreeProps {
  onTargetFolderChange?: (folder: string) => void
  onActionsReady?: (actions: NotesTreeActions) => void
  scrollContainerRef?: React.RefObject<HTMLElement>
}

export function NotesTree({
  onTargetFolderChange,
  onActionsReady,
  scrollContainerRef
}: NotesTreeProps = {}) {
  const data = useNoteTreeData()
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const treeContainerRef = useRef<HTMLDivElement>(null)
  const treeActionsRef = useRef<TreeActionsHandle | null>(null)
  const virtualTreeActionsRef = useRef<VirtualizedTreeActions | null>(null)
  const isTreeFocusedRef = useRef(false)

  const renameCallbackRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.select()
      })
    }
  }, [])

  const folderRenameCallbackRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.select()
      })
    }
  }, [])

  const expandFolderPath = useCallback((folderPath: string) => {
    if (!folderPath) return
    const parts = folderPath.split('/')
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const nodeId = `folder-${current}`
      treeActionsRef.current?.expandNode(nodeId)
      virtualTreeActionsRef.current?.expandNode(nodeId)
    }
  }, [])

  const actions = useNoteTreeActions({
    noteMap: data.noteMap,
    tree: data.tree,
    folders: data.folders,
    notePositions: data.notePositions,
    setNotePositions: data.setNotePositions,
    folderTemplateNames: data.folderTemplateNames,
    setFolderTemplateNames: data.setFolderTemplateNames,
    createFolderMutation: data.createFolder,
    refreshFolders: data.refreshFolders,
    setFolderIcon: data.setFolderIcon,
    mutations: data.mutations,
    selectedIds,
    setSelectedIds,
    computeTargetFolder: data.computeTargetFolder,
    expandFolderPath
  })

  const targetFolder = useMemo(
    () => data.computeTargetFolder(selectedIds),
    [data.computeTargetFolder, selectedIds]
  )

  useEffect(() => {
    onTargetFolderChange?.(targetFolder)
  }, [targetFolder, onTargetFolderChange])

  const handleCollapseAll = useCallback(() => {
    treeActionsRef.current?.collapseAll()
    virtualTreeActionsRef.current?.collapseAll()
  }, [])

  const handleExpandAll = useCallback(() => {
    const allIds = collectAllFolderIds(data.tree)
    treeActionsRef.current?.expandNodes(allIds)
    virtualTreeActionsRef.current?.expandAll()
  }, [data.tree])

  useEffect(() => {
    onActionsReady?.({
      createNote: actions.handleCreateNote,
      createFolder: actions.handleCreateFolder,
      collapseAll: handleCollapseAll,
      expandAll: handleExpandAll
    })
  }, [
    onActionsReady,
    actions.handleCreateNote,
    actions.handleCreateFolder,
    handleCollapseAll,
    handleExpandAll
  ])

  useEffect(() => {
    const container = treeContainerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (actions.renamingNoteId) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        const activeElement = document.activeElement
        if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA') return
        e.preventDefault()
        actions.handleBulkDelete()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds, actions.renamingNoteId, actions.handleBulkDelete])

  const [pendingRevealNoteId, setPendingRevealNoteId] = useState<string | null>(null)

  useEffect(() => {
    const handleRevealInSidebar = (event: CustomEvent<{ path: string; entityId?: string }>) => {
      const { entityId } = event.detail
      if (!entityId) return
      const note = data.noteMap.get(entityId)
      if (!note) return

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

      setPendingRevealNoteId(entityId)
    }

    window.addEventListener('reveal-in-sidebar', handleRevealInSidebar as EventListener)
    return () => {
      window.removeEventListener('reveal-in-sidebar', handleRevealInSidebar as EventListener)
    }
  }, [data.noteMap])

  const handleRevealComplete = useCallback(
    (noteId: string) => {
      setSelectedIds([noteId])
      setTimeout(() => {
        const element = document.querySelector(`[data-tree-node-id="${noteId}"]`)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          element.classList.add('bg-accent')
          setTimeout(() => element.classList.remove('bg-accent'), 2000)
        }
      }, 100)
      setPendingRevealNoteId(null)
    },
    [setSelectedIds]
  )

  if (data.isLoading) return <NotesTreeSkeleton />

  if (data.error) {
    return <NotesTreeError error={extractErrorMessage(data.error, 'Failed to load notes')} />
  }

  if (data.notes.length === 0 && data.folders.length === 0) {
    return (
      <NotesTreeEmpty onCreateNote={actions.handleCreateNote} isCreating={actions.isCreating} />
    )
  }

  const useVirtualizedTree = shouldVirtualize(data.tree)

  const renderNote = (note: NoteListItem, level: number, isLast: boolean, hideLines = false) => {
    const isBeingRenamed = actions.renamingNoteId === note.id
    const isSelected = selectedIds.includes(note.id)
    const isPartOfSelection = isSelected && selectedIds.length > 1

    return (
      <TreeNode key={note.id} nodeId={note.id} level={level} isLast={isLast} hideLines={hideLines}>
        <TreeNodeTrigger
          contextMenuContent={
            <>
              {!isPartOfSelection && (
                <>
                  <ContextMenuItem onClick={() => actions.handleRenameClick(note)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => actions.handleOpenExternal(note)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open in External Editor
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => actions.handleRevealInFinder(note)}>
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Reveal in Finder
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => actions.handleDeleteClick(note)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </>
              )}
              {isPartOfSelection && (
                <ContextMenuItem variant="destructive" onClick={actions.handleBulkDelete}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete {selectedIds.length} Notes
                </ContextMenuItem>
              )}
            </>
          }
        >
          <TreeIcon icon={getFileIcon(note)} />
          {isBeingRenamed ? (
            <input
              ref={renameCallbackRef}
              type="text"
              value={actions.renameValue}
              onChange={(e) => actions.handleRenameInputChange(note.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  actions.handleRenameSubmit(note.id, note.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  actions.handleRenameCancel(note.id)
                }
                e.stopPropagation()
              }}
              onBlur={() => actions.handleRenameSubmit(note.id, note.path)}
              onClick={(e) => e.stopPropagation()}
              disabled={actions.isRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none"
            />
          ) : (
            <TreeLabel>{getDisplayName(note.path)}</TreeLabel>
          )}
          {note.localOnly && <Monitor className="ml-1 h-3 w-3 shrink-0 text-muted-foreground/60" />}
        </TreeNodeTrigger>
      </TreeNode>
    )
  }

  const renderFolder = (folder: FolderNode, level: number, isLast: boolean): ReactNode => {
    const hasChildren = folder.children.length > 0 || folder.notes.length > 0
    const isBeingRenamed = actions.renamingFolderPath === folder.path

    return (
      <TreeNode
        key={folder.path}
        nodeId={`folder-${folder.path}`}
        level={level}
        isLast={isLast}
        acceptsDropInside
      >
        <TreeNodeTrigger
          className=""
          contextMenuContent={
            <>
              <ContextMenuItem onClick={() => actions.handleCreateNoteInFolder(folder.path)}>
                <FilePlus className="mr-2 h-4 w-4" />
                New Note
              </ContextMenuItem>
              <ContextMenuItem onClick={() => actions.handleCreateSubfolder(folder.path)}>
                <FolderPlus className="mr-2 h-4 w-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.handleSetFolderTemplate(folder.path)}>
                <LayoutTemplate className="mr-2 h-4 w-4" />
                Set Default Template
                {data.folderTemplateNames.get(folder.path) && (
                  <span className="ml-1 text-muted-foreground">
                    ({data.folderTemplateNames.get(folder.path)})
                  </span>
                )}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => actions.handleClearFolderTemplate(folder.path)}>
                <X className="mr-2 h-4 w-4" />
                Clear Default Template
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.setIconPickerFolderPath(folder.path)}>
                <Smile className="mr-2 h-4 w-4" />
                Set Icon
              </ContextMenuItem>
              {folder.icon && (
                <ContextMenuItem onClick={() => void data.setFolderIcon(folder.path, null)}>
                  <X className="mr-2 h-4 w-4" />
                  Remove Icon
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.handleRenameFolderClick(folder.path)}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => actions.handleDeleteFolderClick(folder.path)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </ContextMenuItem>
            </>
          }
        >
          <TreeFolderIcon
            nodeId={`folder-${folder.path}`}
            icon={folder.icon ?? null}
            hasChildren={hasChildren}
            onIconChange={(icon) => void data.setFolderIcon(folder.path, icon)}
            pickerOpen={actions.iconPickerFolderPath === folder.path}
            onPickerOpenChange={(open) =>
              actions.setIconPickerFolderPath(open ? folder.path : null)
            }
          />
          {isBeingRenamed ? (
            <input
              ref={folderRenameCallbackRef}
              type="text"
              value={actions.folderRenameValue}
              onChange={(e) => actions.setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  actions.handleFolderRenameSubmit(folder.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  actions.handleFolderRenameCancel()
                }
                e.stopPropagation()
              }}
              onBlur={() => actions.handleFolderRenameSubmit(folder.path)}
              onClick={(e) => e.stopPropagation()}
              disabled={actions.isFolderRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none"
            />
          ) : (
            <div className="group/folder flex flex-1 items-center min-w-0">
              <TreeLabel className="flex-1">{folder.name}</TreeLabel>
              <div className="flex items-center opacity-0 group-hover/folder:opacity-100 transition-opacity ml-auto">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.handleOpenFolderView(folder.path)
                  }}
                  className="p-1 cursor-pointer rounded"
                  aria-label="Open folder view"
                >
                  <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            </div>
          )}
        </TreeNodeTrigger>
        {hasChildren && (
          <TreeNodeContent hasChildren>
            {folder.children.map((child, index) =>
              renderFolder(
                child,
                level + 1,
                index === folder.children.length - 1 && folder.notes.length === 0
              )
            )}
            {folder.notes.map((note, index) =>
              renderNote(note, level + 1, index === folder.notes.length - 1)
            )}
          </TreeNodeContent>
        )}
      </TreeNode>
    )
  }

  return (
    <div
      ref={treeContainerRef}
      className="flex flex-col"
      tabIndex={-1}
      onFocus={() => {
        isTreeFocusedRef.current = true
      }}
      onBlur={(e) => {
        if (!treeContainerRef.current?.contains(e.relatedTarget as Node)) {
          isTreeFocusedRef.current = false
        }
      }}
    >
      {useVirtualizedTree ? (
        <VirtualizedNotesTree
          actionsRef={virtualTreeActionsRef}
          tree={data.tree}
          selectedIds={selectedIds}
          onSelectionChange={actions.handleSelectionChange}
          onMove={actions.handleMove}
          onBulkDelete={actions.handleBulkDelete}
          onRenameNote={actions.handleRenameClick}
          onDeleteNote={actions.handleDeleteClick}
          onOpenExternal={actions.handleOpenExternal}
          onRevealInFinder={actions.handleRevealInFinder}
          onDeleteFolder={actions.handleDeleteFolderClick}
          onCreateNote={actions.handleCreateNoteInFolder}
          onCreateFolder={actions.handleCreateSubfolder}
          onRenameFolder={actions.handleRenameFolderClick}
          onSetFolderTemplate={actions.handleSetFolderTemplate}
          onClearFolderTemplate={actions.handleClearFolderTemplate}
          folderTemplateNames={data.folderTemplateNames}
          onSetFolderIcon={(path, icon) => void data.setFolderIcon(path, icon)}
          noteMap={data.noteMap}
          isDragDisabled={
            !!actions.renamingNoteId || !!actions.renamingFolderPath || actions.isMoving
          }
          scrollContainerRef={scrollContainerRef}
        />
      ) : (
        <TreeProvider
          persistKey="sidebar-tree-expanded"
          selectedIds={selectedIds}
          onSelectionChange={actions.handleSelectionChange}
          draggable={!actions.renamingNoteId && !actions.renamingFolderPath && !actions.isMoving}
          onMove={actions.handleMove}
          animateExpand={false}
          multiSelect={true}
          indent={26}
        >
          <TreeActionsExposer actionsRef={treeActionsRef} />
          <RevealHandler
            pendingRevealNoteId={pendingRevealNoteId}
            noteMap={data.noteMap}
            onReveal={handleRevealComplete}
            onClear={() => setPendingRevealNoteId(null)}
          />
          <FolderRevealHandler />
          <TreeView>
            {data.tree.folders.map((folder, index) =>
              renderFolder(
                folder,
                0,
                index === data.tree.folders.length - 1 && data.tree.rootNotes.length === 0
              )
            )}
            {data.tree.rootNotes.map((note, index) =>
              renderNote(note, 1, index === data.tree.rootNotes.length - 1, true)
            )}
          </TreeView>
        </TreeProvider>
      )}

      <NoteTreeDeleteDialog
        open={actions.isDeleteDialogOpen}
        onOpenChange={actions.setIsDeleteDialogOpen}
        notesToDelete={actions.notesToDelete}
        foldersToDelete={actions.foldersToDelete}
        isDeleting={actions.isDeleting}
        onConfirm={actions.handleDeleteConfirm}
      />

      <NoteTreeTemplateSelector
        isOpen={actions.folderToConfigureTemplate !== null}
        onClose={() => actions.handleFolderTemplateSelect(null)}
        onSelect={actions.handleFolderTemplateSelect}
      />
    </div>
  )
}

export default NotesTree
