"use client"

/**
 * NotesTree Component
 *
 * Displays real notes from the vault in a tree structure.
 * Replaces the hardcoded FileTree with data from useNotes() hook.
 */

import { useMemo, useCallback, useState, useRef, useEffect, type ReactNode } from "react"
import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
} from "@/components/kibo-ui/tree"
import { useTabs } from "@/contexts/tabs"
import { useNotes, useNoteFolders, type NoteListItem } from "@/hooks/use-notes"
import { notesService } from "@/services/notes-service"
import {
  FileText,
  Folder,
  AlertCircle,
  FileQuestion,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  ExternalLink,
  FolderOpen,
  FilePlus,
  FolderPlus,
} from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// ============================================================================
// Types
// ============================================================================

interface FolderNode {
  name: string
  path: string
  children: FolderNode[]
  notes: NoteListItem[]
}

interface TreeStructure {
  folders: FolderNode[]
  rootNotes: NoteListItem[]
}

/**
 * Get display name from note path (filename without extension)
 */
function getDisplayName(notePath: string): string {
  const filename = notePath.split('/').pop() || notePath
  return filename.replace(/\.md$/i, '')
}

// ============================================================================
// Tree Building Utilities
// ============================================================================

/**
 * Build a tree structure from flat notes list and folders.
 */
function buildTreeFromNotes(notes: NoteListItem[], folders: string[]): TreeStructure {
  const folderMap = new Map<string, FolderNode>()
  const rootNotes: NoteListItem[] = []

  // Initialize folder structure
  folders.forEach((folderPath) => {
    const parts = folderPath.split("/").filter(Boolean)
    let currentPath = ""

    parts.forEach((part) => {
      const parentPath = currentPath
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (!folderMap.has(currentPath)) {
        const node: FolderNode = {
          name: part,
          path: currentPath,
          children: [],
          notes: [],
        }
        folderMap.set(currentPath, node)

        // Add to parent's children
        if (parentPath && folderMap.has(parentPath)) {
          const parent = folderMap.get(parentPath)!
          if (!parent.children.some((c) => c.path === currentPath)) {
            parent.children.push(node)
          }
        }
      }
    })
  })

  // Assign notes to folders
  notes.forEach((note) => {
    // note.path is like "notes/subfolder/note.md" - we need the folder part
    const pathParts = note.path.split("/")
    pathParts.pop() // Remove filename

    if (pathParts.length === 0 || pathParts[0] === "notes") {
      // Root level note (in notes/ folder directly)
      if (pathParts.length <= 1) {
        rootNotes.push(note)
      } else {
        // Note is in a subfolder
        const folderPath = pathParts.slice(1).join("/") // Remove "notes" prefix
        if (folderMap.has(folderPath)) {
          folderMap.get(folderPath)!.notes.push(note)
        } else {
          // Folder not in list, add note to root
          rootNotes.push(note)
        }
      }
    } else {
      // Note path doesn't start with "notes/"
      const folderPath = pathParts.join("/")
      if (folderMap.has(folderPath)) {
        folderMap.get(folderPath)!.notes.push(note)
      } else {
        rootNotes.push(note)
      }
    }
  })

  // Get root-level folders (no parent)
  const rootFolders = Array.from(folderMap.values()).filter((folder) => {
    return !folder.path.includes("/")
  })

  return {
    folders: rootFolders,
    rootNotes,
  }
}

// ============================================================================
// Sub-components
// ============================================================================

function NotesTreeSkeleton() {
  return (
    <div className="space-y-2 p-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-3/4 ml-4" />
      <Skeleton className="h-6 w-3/4 ml-4" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-2/3 ml-4" />
    </div>
  )
}

function NotesTreeEmpty({ onCreateNote, isCreating }: { onCreateNote: () => void; isCreating: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center p-4 text-center text-muted-foreground">
      <FileQuestion className="h-8 w-8 mb-2 opacity-50" />
      <p className="text-sm">No notes yet</p>
      <p className="text-xs opacity-70 mb-3">Create a note to get started</p>
      <Button
        variant="outline"
        size="sm"
        onClick={onCreateNote}
        disabled={isCreating}
        className="gap-1.5"
      >
        {isCreating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        New Note
      </Button>
    </div>
  )
}

function NotesTreeError({ error }: { error: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-4 text-center text-destructive">
      <AlertCircle className="h-8 w-8 mb-2" />
      <p className="text-sm">Failed to load notes</p>
      <p className="text-xs opacity-70">{error}</p>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

interface NotesTreeProps {
  /** Callback to receive action buttons for external rendering */
  onActionsReady?: (actions: React.ReactNode) => void
}

export function NotesTree({ onActionsReady }: NotesTreeProps = {}) {
  const { notes, isLoading, error, createNote, deleteNote, renameNote } = useNotes({ autoLoad: true })
  const { folders, createFolder, refresh: refreshFolders } = useNoteFolders()
  const { openTab, closeTab } = useTabs()
  const [isCreating, setIsCreating] = useState(false)
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)

  // Multi-selection state (controlled mode)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // Dialog state for single/bulk delete
  const [notesToDelete, setNotesToDelete] = useState<NoteListItem[]>([])
  const [foldersToDelete, setFoldersToDelete] = useState<string[]>([])
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Inline rename state for notes
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)

  // Inline rename state for folders
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState("")
  const [isFolderRenaming, setIsFolderRenaming] = useState(false)
  const folderRenameInputRef = useRef<HTMLInputElement>(null)

  // Focus input when note renaming starts
  useEffect(() => {
    if (renamingNoteId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingNoteId])

  // Focus input when folder renaming starts
  useEffect(() => {
    if (renamingFolderPath && folderRenameInputRef.current) {
      folderRenameInputRef.current.focus()
      folderRenameInputRef.current.select()
    }
  }, [renamingFolderPath])

  // Build tree structure from notes and folders
  const tree = useMemo(() => {
    return buildTreeFromNotes(notes, folders)
  }, [notes, folders])

  // Map of noteId to note for quick lookup
  const noteMap = useMemo(() => {
    const map = new Map<string, NoteListItem>()
    notes.forEach((note) => map.set(note.id, note))
    return map
  }, [notes])

  // Compute target folder from selection (for creating notes/folders in context)
  const targetFolder = useMemo(() => {
    if (selectedIds.length === 0) return "" // root

    const selectedId = selectedIds[0]

    // If folder selected, use its path
    if (selectedId.startsWith("folder-")) {
      return selectedId.replace("folder-", "")
    }

    // If note selected, get its parent folder
    const note = noteMap.get(selectedId)
    if (note) {
      const parts = note.path.split("/")
      parts.pop() // remove filename
      // If path is "notes/subfolder/file.md", after pop we have ["notes", "subfolder"]
      // We want "subfolder" (remove the "notes" prefix)
      if (parts.length > 1 && parts[0] === "notes") {
        return parts.slice(1).join("/")
      }
      return "" // root notes folder
    }

    return ""
  }, [selectedIds, noteMap])

  // Handle note selection - update state and optionally open in tab
  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      // Keep all IDs including folders for context-aware creation
      setSelectedIds(ids)

      // Only open in tab on single note selection (not folders, not multi-select)
      const noteIds = ids.filter((id) => !id.startsWith("folder-") && id !== "notes-root")
      if (noteIds.length === 1) {
        const note = noteMap.get(noteIds[0])
        if (note) {
          openTab({
            type: "note",
            title: getDisplayName(note.path),
            icon: "file-text",
            path: `/notes/${note.id}`,
            entityId: note.id,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false,
          })
        }
      }
    },
    [noteMap, openTab]
  )

  // Handle creating a new note (in target folder)
  const handleCreateNote = useCallback(async () => {
    if (isCreating) return

    setIsCreating(true)
    try {
      const newNote = await createNote({
        title: "Untitled",
        content: "",
        folder: targetFolder || undefined, // Create in selected folder
      })

      if (newNote) {
        // Open the new note in a tab
        openTab({
          type: "note",
          title: getDisplayName(newNote.path),
          icon: "file-text",
          path: `/notes/${newNote.id}`,
          entityId: newNote.id,
          isPinned: false,
          isModified: false,
          isPreview: false, // Not preview mode since we're creating it
          isDeleted: false,
        })

        // Auto-focus rename mode for the new note
        setRenamingNoteId(newNote.id)
        setRenameValue("Untitled")
      }
    } catch (err) {
      console.error("Failed to create note:", err)
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, createNote, openTab, targetFolder])

  // Handle creating a new folder (in target folder)
  const handleCreateFolder = useCallback(async () => {
    if (isCreatingFolder) return

    setIsCreatingFolder(true)
    try {
      // Generate unique folder name
      const baseName = "Untitled Folder"
      let folderName = baseName
      let counter = 1
      const targetPath = targetFolder ? `${targetFolder}/` : ""

      // Check for existing folders with same name
      while (folders.includes(`${targetPath}${folderName}`)) {
        folderName = `${baseName} ${counter++}`
      }

      const fullPath = `${targetPath}${folderName}`
      const success = await createFolder(fullPath)

      if (success) {
        // Reload folders to show the new one
        await refreshFolders()

        // Auto-focus rename mode for the new folder
        setRenamingFolderPath(fullPath)
        setFolderRenameValue(folderName)
      }
    } catch (err) {
      console.error("Failed to create folder:", err)
    } finally {
      setIsCreatingFolder(false)
    }
  }, [isCreatingFolder, createFolder, folders, targetFolder, refreshFolders])

  // Handle creating a note in a specific folder (from context menu)
  const handleCreateNoteInFolder = useCallback(async (folderPath: string) => {
    if (isCreating) return

    setIsCreating(true)
    try {
      const newNote = await createNote({
        title: "Untitled",
        content: "",
        folder: folderPath || undefined,
      })

      if (newNote) {
        openTab({
          type: "note",
          title: getDisplayName(newNote.path),
          icon: "file-text",
          path: `/notes/${newNote.id}`,
          entityId: newNote.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
        })
      }
    } catch (err) {
      console.error("Failed to create note:", err)
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, createNote, openTab])

  // Handle creating a subfolder in a specific folder (from context menu)
  const handleCreateSubfolder = useCallback(async (parentPath: string) => {
    if (isCreatingFolder) return

    setIsCreatingFolder(true)
    try {
      const baseName = "Untitled Folder"
      let folderName = baseName
      let counter = 1
      const targetPath = parentPath ? `${parentPath}/` : ""

      while (folders.includes(`${targetPath}${folderName}`)) {
        folderName = `${baseName} ${counter++}`
      }

      const fullPath = `${targetPath}${folderName}`
      const success = await createFolder(fullPath)

      if (success) {
        await refreshFolders()
      }
    } catch (err) {
      console.error("Failed to create folder:", err)
    } finally {
      setIsCreatingFolder(false)
    }
  }, [isCreatingFolder, createFolder, folders, refreshFolders])

  // Context menu action handlers
  const handleRenameClick = useCallback((note: NoteListItem) => {
    setRenamingNoteId(note.id)
    setRenameValue(getDisplayName(note.path))
  }, [])

  const handleRenameSubmit = useCallback(async (noteId: string, originalPath: string) => {
    if (!renameValue.trim() || isRenaming) {
      setRenamingNoteId(null)
      return
    }

    const currentName = getDisplayName(originalPath)
    if (renameValue.trim() === currentName) {
      setRenamingNoteId(null)
      return
    }

    setIsRenaming(true)
    try {
      await renameNote(noteId, renameValue.trim())
    } catch (err) {
      console.error("Failed to rename note:", err)
    } finally {
      setIsRenaming(false)
      setRenamingNoteId(null)
    }
  }, [renameValue, isRenaming, renameNote])

  const handleRenameCancel = useCallback(() => {
    setRenamingNoteId(null)
    setRenameValue("")
  }, [])

  // Folder rename handlers
  const handleRenameFolderClick = useCallback((folderPath: string) => {
    setRenamingFolderPath(folderPath)
    const folderName = folderPath.split("/").pop() || folderPath
    setFolderRenameValue(folderName)
  }, [])

  const handleFolderRenameSubmit = useCallback(async (oldPath: string) => {
    if (!folderRenameValue.trim() || isFolderRenaming) {
      setRenamingFolderPath(null)
      return
    }

    const oldName = oldPath.split("/").pop() || oldPath
    if (folderRenameValue.trim() === oldName) {
      setRenamingFolderPath(null)
      return
    }

    setIsFolderRenaming(true)
    try {
      // Build new path: replace last segment with new name
      const parentPath = oldPath.includes("/")
        ? oldPath.substring(0, oldPath.lastIndexOf("/"))
        : ""
      const newPath = parentPath
        ? `${parentPath}/${folderRenameValue.trim()}`
        : folderRenameValue.trim()

      await notesService.renameFolder(oldPath, newPath)
      await refreshFolders()
    } catch (err) {
      console.error("Failed to rename folder:", err)
    } finally {
      setIsFolderRenaming(false)
      setRenamingFolderPath(null)
    }
  }, [folderRenameValue, isFolderRenaming, refreshFolders])

  const handleFolderRenameCancel = useCallback(() => {
    setRenamingFolderPath(null)
    setFolderRenameValue("")
  }, [])

  // Delete single note from context menu
  const handleDeleteClick = useCallback((note: NoteListItem) => {
    setNotesToDelete([note])
    setFoldersToDelete([])
    setIsDeleteDialogOpen(true)
  }, [])

  // Delete single folder from context menu
  const handleDeleteFolderClick = useCallback((folderPath: string) => {
    setNotesToDelete([])
    setFoldersToDelete([folderPath])
    setIsDeleteDialogOpen(true)
  }, [])

  // Delete all selected items (notes and folders)
  const handleBulkDelete = useCallback(() => {
    // Separate folder IDs from note IDs
    const folderPaths: string[] = []
    const selectedNotes: NoteListItem[] = []

    for (const id of selectedIds) {
      if (id.startsWith("folder-")) {
        // Extract folder path from "folder-path/to/folder" format
        const folderPath = id.replace("folder-", "")
        folderPaths.push(folderPath)
      } else {
        const note = noteMap.get(id)
        if (note) {
          selectedNotes.push(note)
        }
      }
    }

    if (selectedNotes.length > 0 || folderPaths.length > 0) {
      setNotesToDelete(selectedNotes)
      setFoldersToDelete(folderPaths)
      setIsDeleteDialogOpen(true)
    }
  }, [selectedIds, noteMap])

  const handleDeleteConfirm = useCallback(async () => {
    if ((notesToDelete.length === 0 && foldersToDelete.length === 0) || isDeleting) return

    setIsDeleting(true)
    try {
      // Delete notes first (before folders, in case notes are inside folders)
      for (const note of notesToDelete) {
        const success = await deleteNote(note.id)
        if (success) {
          // Close the tab if it's open
          closeTab(`/notes/${note.id}`)
        }
      }

      // Delete folders (this also deletes any nested notes)
      for (const folderPath of foldersToDelete) {
        await notesService.deleteFolder(folderPath)
      }

      // Refresh folders list if any folders were deleted
      if (foldersToDelete.length > 0) {
        await refreshFolders()
      }

      setIsDeleteDialogOpen(false)
      setNotesToDelete([])
      setFoldersToDelete([])
      setSelectedIds([]) // Clear selection after delete
    } catch (err) {
      console.error("Failed to delete items:", err)
    } finally {
      setIsDeleting(false)
    }
  }, [notesToDelete, foldersToDelete, isDeleting, deleteNote, closeTab, refreshFolders])

  const handleOpenExternal = useCallback(async (note: NoteListItem) => {
    try {
      await notesService.openExternal(note.id)
    } catch (err) {
      console.error("Failed to open note externally:", err)
    }
  }, [])

  const handleRevealInFinder = useCallback(async (note: NoteListItem) => {
    try {
      await notesService.revealInFinder(note.id)
    } catch (err) {
      console.error("Failed to reveal note in Finder:", err)
    }
  }, [])

  // Handle Delete key to delete selected notes
  useEffect(() => {
    const container = treeContainerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if we're renaming
      if (renamingNoteId) return

      // Delete or Backspace key
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length > 0) {
        // Make sure we're focused on the tree, not an input
        const activeElement = document.activeElement
        if (activeElement?.tagName === "INPUT" || activeElement?.tagName === "TEXTAREA") {
          return
        }

        e.preventDefault()
        handleBulkDelete()
      }
    }

    container.addEventListener("keydown", handleKeyDown)
    return () => container.removeEventListener("keydown", handleKeyDown)
  }, [selectedIds, renamingNoteId, handleBulkDelete])

  // Render action buttons (must be before early returns to follow Rules of Hooks)
  const actionButtons = useMemo(() => (
    <>
      {/* New Note button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCreateNote}
            disabled={isCreating}
          >
            {isCreating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FilePlus className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">New Note</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>New note{targetFolder ? ` in ${targetFolder}` : ""}</p>
        </TooltipContent>
      </Tooltip>
      {/* New Folder button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCreateFolder}
            disabled={isCreatingFolder}
          >
            {isCreatingFolder ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">New Folder</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>New folder{targetFolder ? ` in ${targetFolder}` : ""}</p>
        </TooltipContent>
      </Tooltip>
    </>
  ), [handleCreateNote, handleCreateFolder, isCreating, isCreatingFolder, targetFolder])

  // Notify parent about action buttons (must be before early returns)
  useEffect(() => {
    onActionsReady?.(actionButtons)
  }, [onActionsReady, actionButtons])

  // Render loading state
  if (isLoading) {
    return <NotesTreeSkeleton />
  }

  // Render error state
  if (error) {
    return <NotesTreeError error={error} />
  }

  // Render empty state
  if (notes.length === 0) {
    return <NotesTreeEmpty onCreateNote={handleCreateNote} isCreating={isCreating} />
  }

  // Render note item with context menu
  const renderNote = (note: NoteListItem, level: number, isLast: boolean) => {
    const isBeingRenamed = renamingNoteId === note.id
    const isSelected = selectedIds.includes(note.id)
    const hasMultipleSelected = selectedIds.length > 1
    const isPartOfSelection = isSelected && hasMultipleSelected

    return (
      <TreeNode
        key={note.id}
        nodeId={note.id}
        level={level}
        isLast={isLast}
      >
        <TreeNodeTrigger
          contextMenuContent={
            <>
              {/* Single item actions - only show when not part of multi-select */}
              {!isPartOfSelection && (
                <>
                  <ContextMenuItem onClick={() => handleRenameClick(note)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => handleOpenExternal(note)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open in External Editor
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleRevealInFinder(note)}>
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Reveal in Finder
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => handleDeleteClick(note)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </>
              )}
              {/* Bulk actions - show when part of multi-select */}
              {isPartOfSelection && (
                <ContextMenuItem
                  variant="destructive"
                  onClick={handleBulkDelete}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete {selectedIds.length} Notes
                </ContextMenuItem>
              )}
            </>
          }
        >
          <TreeExpander />
          <TreeIcon icon={<FileText className="h-4 w-4 text-muted-foreground" />} />
          {isBeingRenamed ? (
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleRenameSubmit(note.id, note.path)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  handleRenameCancel()
                }
                e.stopPropagation()
              }}
              onBlur={() => handleRenameSubmit(note.id, note.path)}
              onClick={(e) => e.stopPropagation()}
              disabled={isRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <TreeLabel>{getDisplayName(note.path)}</TreeLabel>
          )}
        </TreeNodeTrigger>
      </TreeNode>
    )
  }

  // Render folder with its contents
  const renderFolder = (
    folder: FolderNode,
    level: number,
    isLast: boolean
  ): ReactNode => {
    const hasChildren = folder.children.length > 0 || folder.notes.length > 0
    const isBeingRenamed = renamingFolderPath === folder.path

    return (
      <TreeNode
        key={folder.path}
        nodeId={`folder-${folder.path}`}
        level={level}
        isLast={isLast}
      >
        <TreeNodeTrigger
          contextMenuContent={
            <>
              <ContextMenuItem onClick={() => handleCreateNoteInFolder(folder.path)}>
                <FilePlus className="mr-2 h-4 w-4" />
                New Note
              </ContextMenuItem>
              <ContextMenuItem onClick={() => handleCreateSubfolder(folder.path)}>
                <FolderPlus className="mr-2 h-4 w-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => handleRenameFolderClick(folder.path)}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => handleDeleteFolderClick(folder.path)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </ContextMenuItem>
            </>
          }
        >
          <TreeExpander hasChildren={hasChildren} />
          <TreeIcon
            hasChildren={hasChildren}
            icon={<Folder className="h-4 w-4" />}
          />
          {isBeingRenamed ? (
            <input
              ref={folderRenameInputRef}
              type="text"
              value={folderRenameValue}
              onChange={(e) => setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleFolderRenameSubmit(folder.path)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  handleFolderRenameCancel()
                }
                e.stopPropagation()
              }}
              onBlur={() => handleFolderRenameSubmit(folder.path)}
              onClick={(e) => e.stopPropagation()}
              disabled={isFolderRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <TreeLabel>{folder.name}</TreeLabel>
          )}
        </TreeNodeTrigger>
        {hasChildren && (
          <TreeNodeContent hasChildren>
            {/* Render subfolders */}
            {folder.children.map((child, index) =>
              renderFolder(
                child,
                level + 1,
                index === folder.children.length - 1 && folder.notes.length === 0
              )
            )}
            {/* Render notes in this folder */}
            {folder.notes.map((note, index) =>
              renderNote(
                note,
                level + 1,
                index === folder.notes.length - 1
              )
            )}
          </TreeNodeContent>
        )}
      </TreeNode>
    )
  }

  return (
    <div ref={treeContainerRef} className="flex flex-col" tabIndex={-1}>
      {/* Tree View */}
      <TreeProvider
        selectedIds={selectedIds}
        onSelectionChange={handleSelectionChange}
        draggable={false}
        animateExpand={true}
        multiSelect={true}
        indent={16}
      >
        <TreeView>
          {/* Folders first */}
          {tree.folders.map((folder, index) =>
            renderFolder(
              folder,
              0,
              index === tree.folders.length - 1 && tree.rootNotes.length === 0
            )
          )}

          {/* Root notes after folders */}
          {tree.rootNotes.map((note, index) =>
            renderNote(
              note,
              0,
              index === tree.rootNotes.length - 1
            )
          )}
        </TreeView>
      </TreeProvider>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {(() => {
                const totalItems = notesToDelete.length + foldersToDelete.length
                if (totalItems === 1) {
                  if (foldersToDelete.length === 1) return "Delete Folder"
                  return "Delete Note"
                }
                return `Delete ${totalItems} Items`
              })()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const totalItems = notesToDelete.length + foldersToDelete.length

                // Single item
                if (totalItems === 1) {
                  if (foldersToDelete.length === 1) {
                    const folderName = foldersToDelete[0].split("/").pop() || foldersToDelete[0]
                    return (
                      <>Are you sure you want to delete the folder &quot;{folderName}&quot; and all its contents? This action cannot be undone.</>
                    )
                  }
                  return (
                    <>Are you sure you want to delete &quot;{getDisplayName(notesToDelete[0]?.path || "")}&quot;? This action cannot be undone.</>
                  )
                }

                // Multiple items
                return (
                  <>
                    Are you sure you want to delete these items? This action cannot be undone.
                    <ul className="mt-2 max-h-32 overflow-y-auto text-sm list-disc list-inside">
                      {foldersToDelete.slice(0, 3).map((folderPath) => (
                        <li key={`folder-${folderPath}`} className="flex items-center gap-1">
                          <Folder className="h-3 w-3 inline" />
                          {folderPath.split("/").pop() || folderPath} (folder)
                        </li>
                      ))}
                      {notesToDelete.slice(0, 5 - Math.min(foldersToDelete.length, 3)).map((note) => (
                        <li key={note.id}>{getDisplayName(note.path)}</li>
                      ))}
                      {totalItems > 5 && (
                        <li className="text-muted-foreground">...and {totalItems - 5} more</li>
                      )}
                    </ul>
                  </>
                )
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                (notesToDelete.length + foldersToDelete.length) === 1 ? "Delete" : `Delete ${notesToDelete.length + foldersToDelete.length}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default NotesTree
