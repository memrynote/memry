'use client'

import {
  forwardRef,
  useCallback,
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  type ReactNode
} from 'react'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
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
import { ApplyTemplateToNoteDialog } from '@/components/note/apply-template-to-note-dialog'
import {
  NotesTreeSkeleton,
  NotesTreeEmpty,
  NotesTreeError,
  NotesTreeTruncationNotice
} from '@/components/note-tree-states'
import {
  TreeFolderIcon,
  RevealHandler,
  FolderRevealHandler,
  TreeActionsExposer,
  type TreeActionsHandle
} from '@/components/note-tree-internal'
import {
  extractFolderFromPath,
  getDisplayName,
  getFileExtensionLabel,
  getFileIcon,
  collectAllFolderIds,
  type FolderNode
} from '@/components/notes-tree-utils'
import { FILE_DROP_FOLDER_ATTR } from '@/hooks/use-file-drop'
import { handleInlineRenameBlur } from '@/lib/inline-rename-focus'
import { cn } from '@/lib/utils'
import { IconPickerButton } from '@/components/icon-picker-button'
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
import { BookmarkMenuItem } from '@/components/sidebar/bookmark-menu-item'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { noteTabData, folderTabData } from '@/lib/sidebar-tab-data'
import { shouldVirtualize } from '@/lib/virtualized-tree-utils'
import {
  VirtualizedNotesTree,
  type VirtualizedTreeActions
} from '@/components/virtualized-notes-tree'
import { useT } from '@memry/i18n/renderer'

const LEADING_SPACER = <div className="h-4 w-4" />

// ============================================================================
// Main Component
// ============================================================================

export interface NotesTreeActions {
  createNote: () => void
  createFolder: () => void
  collapseAll: () => void
  expandAll: () => void
}

interface NotesTreeProps {
  onTargetFolderChange?: (folder: string) => void
  scrollContainerRef?: React.RefObject<HTMLElement>
  /**
   * Vault-relative folder an in-flight external file drag is aimed at, or null
   * when no file is being dragged. Highlight only — the drop reads its own
   * destination off `FILE_DROP_FOLDER_ATTR` in the DOM.
   */
  fileDropFolder?: string | null
}

export const NotesTree = forwardRef<NotesTreeActions, NotesTreeProps>(function NotesTree(
  { onTargetFolderChange, scrollContainerRef, fileDropFolder = null }: NotesTreeProps = {},
  ref
) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
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

  // Expansion is keyed by folder path, so a folder that moves would otherwise
  // come back collapsed — along with everything open inside it.
  const renameFolderPath = useCallback((oldPath: string, newPath: string) => {
    const oldNodeId = `folder-${oldPath}`
    const newNodeId = `folder-${newPath}`
    treeActionsRef.current?.renameNode(oldNodeId, newNodeId)
    virtualTreeActionsRef.current?.renameNode(oldNodeId, newNodeId)
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
    expandFolderPath,
    renameFolderPath
  })

  const notifyTargetFolderChange = useCallback(
    (ids: string[]) => {
      onTargetFolderChange?.(data.computeTargetFolder(ids))
    },
    [data, onTargetFolderChange]
  )

  const handleCollapseAll = useCallback(() => {
    treeActionsRef.current?.collapseAll()
    virtualTreeActionsRef.current?.collapseAll()
  }, [])

  const handleExpandAll = useCallback(() => {
    const allIds = collectAllFolderIds(data.tree)
    treeActionsRef.current?.expandNodes(allIds)
    virtualTreeActionsRef.current?.expandAll()
  }, [data.tree])

  useImperativeHandle(
    ref,
    () => ({
      createNote: actions.handleCreateNote,
      createFolder: actions.handleCreateFolder,
      collapseAll: handleCollapseAll,
      expandAll: handleExpandAll
    }),
    [actions.handleCreateNote, actions.handleCreateFolder, handleCollapseAll, handleExpandAll]
  )

  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      actions.handleSelectionChange(ids)
      notifyTargetFolderChange(ids)
    },
    [actions, notifyTargetFolderChange]
  )

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
  }, [selectedIds, actions.renamingNoteId, actions.handleBulkDelete, actions])

  const [pendingRevealNoteId, setPendingRevealNoteId] = useState<string | null>(null)
  const [applyTemplateNote, setApplyTemplateNote] = useState<NoteListItem | null>(null)

  useEffect(() => {
    const handleRevealInSidebar = (event: CustomEvent<{ path: string; entityId?: string }>) => {
      const { entityId } = event.detail
      if (!entityId) return
      // Deliberately not checked against `noteMap`: a note created a moment ago
      // is not in the tree query yet, and dropping the request here is what used
      // to make a brand-new note impossible to reveal. RevealHandler waits.

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
  }, [])

  const handleRevealComplete = useCallback(
    (noteId: string) => {
      setSelectedIds([noteId])
      notifyTargetFolderChange([noteId])
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
    [notifyTargetFolderChange]
  )

  // The virtualized tree has no RevealHandler — that lives inside TreeProvider,
  // which only the plain tree renders — so drive it through its imperative
  // handle instead. Waits for the note to reach the tree, the same way
  // RevealHandler does, because a just-created note is not there yet.
  useEffect(() => {
    if (!pendingRevealNoteId || !shouldVirtualize(data.tree)) return
    if (!data.noteMap.has(pendingRevealNoteId)) return

    virtualTreeActionsRef.current?.revealNote(pendingRevealNoteId)
    handleRevealComplete(pendingRevealNoteId)
  }, [pendingRevealNoteId, data.tree, data.noteMap, handleRevealComplete])

  if (data.isLoading) return <NotesTreeSkeleton />

  if (data.error) {
    return (
      <NotesTreeError
        error={extractErrorMessage(
          data.error,
          getI18n().getFixedT(null, 'notes')('tree.loadingError')
        )}
      />
    )
  }

  if (data.notes.length === 0 && data.folders.length === 0) {
    return (
      <NotesTreeEmpty
        onCreateNote={(...args) => void actions.handleCreateNote(...args)}
        isCreating={actions.isCreating}
      />
    )
  }

  const useVirtualizedTree = shouldVirtualize(data.tree)

  const renderNote = (note: NoteListItem, level: number, isLast: boolean, hideLines = false) => {
    const isBeingRenamed = actions.renamingNoteId === note.id
    const isSelected = selectedIds.includes(note.id)
    const isPartOfSelection = isSelected && selectedIds.length > 1

    return (
      <TreeNode
        key={note.id}
        nodeId={note.id}
        level={level}
        isLast={isLast}
        hideLines={hideLines}
        canvasNoteId={note.id}
      >
        <TreeNodeTrigger
          // A file dropped on a note belongs in the folder that note lives in.
          {...{ [FILE_DROP_FOLDER_ATTR]: extractFolderFromPath(note.path) }}
          contextMenuContent={
            <>
              {!isPartOfSelection && (
                <>
                  <OpenTargetMenuItems tab={noteTabData(note)} />
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => actions.handleRenameClick(note)}>
                    <Pencil className="me-2 h-4 w-4" />
                    {t('tree.actions.rename')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => setApplyTemplateNote(note)}>
                    <LayoutTemplate className="me-2 h-4 w-4" />
                    {t('tree.actions.applyTemplate')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => actions.setIconPickerNoteId(note.id)}>
                    <Smile className="me-2 h-4 w-4" />
                    {t('tree.actions.setIcon')}
                  </ContextMenuItem>
                  {note.emoji && (
                    <ContextMenuItem
                      onClick={() =>
                        void data.mutations.updateNote.mutateAsync({ id: note.id, emoji: null })
                      }
                    >
                      <X className="me-2 h-4 w-4" />
                      {t('tree.actions.removeIcon')}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => void actions.handleOpenExternal(note)}>
                    <ExternalLink className="me-2 h-4 w-4" />
                    {t('tree.actions.openExternal')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => void actions.handleRevealInFinder(note)}>
                    <FolderOpen className="me-2 h-4 w-4" />
                    {t('tree.actions.revealInFinder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <BookmarkMenuItem itemType="note" itemId={note.id} />
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => actions.handleDeleteClick(note)}
                  >
                    <Trash2 className="me-2 h-4 w-4" />
                    {tCommon('button.delete')}
                  </ContextMenuItem>
                </>
              )}
              {isPartOfSelection && (
                <ContextMenuItem variant="destructive" onClick={actions.handleBulkDelete}>
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('tree.actions.deleteSelectedNotes', { count: selectedIds.length })}
                </ContextMenuItem>
              )}
            </>
          }
        >
          <IconPickerButton
            leading={LEADING_SPACER}
            hasIcon={!!note.emoji}
            onIconChange={(icon) =>
              void data.mutations.updateNote.mutateAsync({ id: note.id, emoji: icon })
            }
            ariaLabel={t('tree.actions.setIcon')}
            pickerOpen={actions.iconPickerNoteId === note.id}
            onPickerOpenChange={(open) => actions.setIconPickerNoteId(open ? note.id : null)}
          >
            {getFileIcon(note)}
          </IconPickerButton>
          {isBeingRenamed ? (
            <input
              ref={renameCallbackRef}
              type="text"
              aria-label={t('tree.actions.rename')}
              value={actions.renameValue}
              onChange={(e) => actions.handleRenameInputChange(note.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void actions.handleRenameSubmit(note.id, note.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  actions.handleRenameCancel(note.id)
                }
                e.stopPropagation()
              }}
              onBlur={(e) =>
                handleInlineRenameBlur(e, () => void actions.handleRenameSubmit(note.id, note.path))
              }
              onClick={(e) => e.stopPropagation()}
              disabled={actions.isRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none"
            />
          ) : (
            <>
              <TreeLabel>{getDisplayName(note.path)}</TreeLabel>
              {getFileExtensionLabel(note) && (
                <span className="ms-2 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                  {getFileExtensionLabel(note)}
                </span>
              )}
            </>
          )}
          {note.localOnly && <Monitor className="ms-1 h-3 w-3 shrink-0 text-muted-foreground/60" />}
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
        hasChildren={hasChildren}
      >
        <TreeNodeTrigger
          {...{ [FILE_DROP_FOLDER_ATTR]: folder.path }}
          className={cn(
            fileDropFolder === folder.path &&
              'border-2 border-dashed border-primary bg-primary/10 hover:bg-primary/10'
          )}
          contextMenuContent={
            <>
              <OpenTargetMenuItems tab={folderTabData(folder.path, folder.icon)} />
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => void actions.handleCreateNoteInFolder(folder.path)}>
                <FilePlus className="me-2 h-4 w-4" />
                {t('tree.actions.newNote')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void actions.handleCreateSubfolder(folder.path)}>
                <FolderPlus className="me-2 h-4 w-4" />
                {t('tree.actions.newFolder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.handleSetFolderTemplate(folder.path)}>
                <LayoutTemplate className="me-2 h-4 w-4" />
                {t('tree.actions.setDefaultTemplate')}
                {data.folderTemplateNames.get(folder.path) && (
                  <span className="ms-1 text-muted-foreground">
                    ({data.folderTemplateNames.get(folder.path)})
                  </span>
                )}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void actions.handleClearFolderTemplate(folder.path)}>
                <X className="me-2 h-4 w-4" />
                {t('tree.actions.clearDefaultTemplate')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.setIconPickerFolderPath(folder.path)}>
                <Smile className="me-2 h-4 w-4" />
                {t('tree.actions.setIcon')}
              </ContextMenuItem>
              {folder.icon && (
                <ContextMenuItem onClick={() => void data.setFolderIcon(folder.path, null)}>
                  <X className="me-2 h-4 w-4" />
                  {t('tree.actions.removeIcon')}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <BookmarkMenuItem itemType="folder" itemId={folder.path} />
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.handleRenameFolderClick(folder.path)}>
                <Pencil className="me-2 h-4 w-4" />
                {t('tree.actions.rename')}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => actions.handleDeleteFolderClick(folder.path)}
              >
                <Trash2 className="me-2 h-4 w-4" />
                {tCommon('button.delete')}
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
              aria-label={t('tree.actions.rename')}
              value={actions.folderRenameValue}
              onChange={(e) => actions.setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void actions.handleFolderRenameSubmit(folder.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  actions.handleFolderRenameCancel()
                }
                e.stopPropagation()
              }}
              onBlur={(e) =>
                handleInlineRenameBlur(e, () => void actions.handleFolderRenameSubmit(folder.path))
              }
              onClick={(e) => e.stopPropagation()}
              disabled={actions.isFolderRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none"
            />
          ) : (
            <div className="group/folder flex flex-1 items-center min-w-0">
              <TreeLabel className="flex-1">{folder.name}</TreeLabel>
              {/* The button inside is in the tab order, so focus has to reveal
                  it too — hover-only would land a keyboard user on a control
                  painted at `opacity-0` (WCAG 2.4.7). */}
              <div className="flex items-center opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 transition-opacity ms-auto">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.handleOpenFolderView(folder.path, folder.icon)
                  }}
                  className="p-1 cursor-pointer rounded"
                  aria-label={t('tree.aria.openFolderView')}
                >
                  <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            </div>
          )}
        </TreeNodeTrigger>
        {hasChildren && (
          <TreeNodeContent>
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
          onSelectionChange={handleSelectionChange}
          onMove={(...args) => void actions.handleMove(...args)}
          onBulkDelete={actions.handleBulkDelete}
          onRenameNote={actions.handleRenameClick}
          renamingNoteId={actions.renamingNoteId}
          renameValue={actions.renameValue}
          onRenameValueChange={actions.handleRenameInputChange}
          onRenameSubmit={(...args) => void actions.handleRenameSubmit(...args)}
          onRenameCancel={actions.handleRenameCancel}
          isRenaming={actions.isRenaming}
          onApplyTemplateToNote={setApplyTemplateNote}
          onDeleteNote={actions.handleDeleteClick}
          onOpenExternal={(...args) => void actions.handleOpenExternal(...args)}
          onRevealInFinder={(...args) => void actions.handleRevealInFinder(...args)}
          onDeleteFolder={actions.handleDeleteFolderClick}
          onCreateNote={(...args) => void actions.handleCreateNoteInFolder(...args)}
          onCreateFolder={(...args) => void actions.handleCreateSubfolder(...args)}
          onRenameFolder={actions.handleRenameFolderClick}
          renamingFolderPath={actions.renamingFolderPath}
          folderRenameValue={actions.folderRenameValue}
          onFolderRenameValueChange={actions.setFolderRenameValue}
          onFolderRenameSubmit={(...args) => void actions.handleFolderRenameSubmit(...args)}
          onFolderRenameCancel={actions.handleFolderRenameCancel}
          isFolderRenaming={actions.isFolderRenaming}
          onSetFolderTemplate={actions.handleSetFolderTemplate}
          onClearFolderTemplate={(...args) => void actions.handleClearFolderTemplate(...args)}
          folderTemplateNames={data.folderTemplateNames}
          onSetFolderIcon={(path, icon) => void data.setFolderIcon(path, icon)}
          onSetNoteIcon={(id, icon) =>
            void data.mutations.updateNote.mutateAsync({ id, emoji: icon })
          }
          noteMap={data.noteMap}
          isDragDisabled={
            !!actions.renamingNoteId || !!actions.renamingFolderPath || actions.isMoving
          }
          fileDropFolder={fileDropFolder}
          scrollContainerRef={scrollContainerRef}
        />
      ) : (
        <TreeProvider
          persistKey="sidebar-tree-expanded"
          selectedIds={selectedIds}
          onSelectionChange={handleSelectionChange}
          draggable={!actions.renamingNoteId && !actions.renamingFolderPath && !actions.isMoving}
          onMove={(...args) => void actions.handleMove(...args)}
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
              renderNote(note, 0, index === data.tree.rootNotes.length - 1, true)
            )}
          </TreeView>
        </TreeProvider>
      )}

      {data.hiddenNoteCount > 0 && (
        <NotesTreeTruncationNotice
          hiddenCount={data.hiddenNoteCount}
          isLoadingMore={data.isLoadingMore}
          onLoadMore={data.loadMore}
        />
      )}

      <NoteTreeDeleteDialog
        open={actions.isDeleteDialogOpen}
        onOpenChange={actions.setIsDeleteDialogOpen}
        notesToDelete={actions.notesToDelete}
        foldersToDelete={actions.foldersToDelete}
        isDeleting={actions.isDeleting}
        onConfirm={(...args) => void actions.handleDeleteConfirm(...args)}
      />

      <NoteTreeTemplateSelector
        isOpen={actions.folderToConfigureTemplate !== null}
        onClose={() => void actions.handleFolderTemplateSelect(null)}
        onSelect={(...args) => void actions.handleFolderTemplateSelect(...args)}
      />

      <ApplyTemplateToNoteDialog
        noteId={applyTemplateNote?.id ?? null}
        isOpen={applyTemplateNote !== null}
        onClose={() => setApplyTemplateNote(null)}
      />
    </div>
  )
})

NotesTree.displayName = 'NotesTree'

export default NotesTree
