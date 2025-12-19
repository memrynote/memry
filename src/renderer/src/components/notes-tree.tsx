"use client"

/**
 * NotesTree Component
 *
 * Displays real notes from the vault in a tree structure.
 * Replaces the hardcoded FileTree with data from useNotes() hook.
 */

import { useMemo, useCallback, useState, type ReactNode } from "react"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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

export function NotesTree() {
  const { notes, isLoading, error, createNote, deleteNote, renameNote } = useNotes({ autoLoad: true })
  const { folders } = useNoteFolders()
  const { openTab, closeTab } = useTabs()
  const [isCreating, setIsCreating] = useState(false)

  // Dialog state
  const [selectedNote, setSelectedNote] = useState<NoteListItem | null>(null)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)

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

  // Handle note selection - open in tab
  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return

      const selectedId = ids[0]
      const note = noteMap.get(selectedId)

      if (note) {
        openTab({
          type: "note",
          title: note.title,
          icon: "file-text",
          path: `/notes/${note.id}`,
          entityId: note.id,
          isPinned: false,
          isModified: false,
          isPreview: true,
        })
      }
    },
    [noteMap, openTab]
  )

  // Handle creating a new note
  const handleCreateNote = useCallback(async () => {
    if (isCreating) return

    setIsCreating(true)
    try {
      const newNote = await createNote({
        title: "Untitled",
        content: "",
      })

      if (newNote) {
        // Open the new note in a tab
        openTab({
          type: "note",
          title: newNote.title,
          icon: "file-text",
          path: `/notes/${newNote.id}`,
          entityId: newNote.id,
          isPinned: false,
          isModified: false,
          isPreview: false, // Not preview mode since we're creating it
        })
      }
    } catch (err) {
      console.error("Failed to create note:", err)
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, createNote, openTab])

  // Context menu action handlers
  const handleRenameClick = useCallback((note: NoteListItem) => {
    setSelectedNote(note)
    setNewTitle(note.title)
    setIsRenameDialogOpen(true)
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!selectedNote || !newTitle.trim() || isRenaming) return
    if (newTitle.trim() === selectedNote.title) {
      setIsRenameDialogOpen(false)
      return
    }

    setIsRenaming(true)
    try {
      await renameNote(selectedNote.id, newTitle.trim())
      setIsRenameDialogOpen(false)
    } catch (err) {
      console.error("Failed to rename note:", err)
    } finally {
      setIsRenaming(false)
    }
  }, [selectedNote, newTitle, isRenaming, renameNote])

  const handleDeleteClick = useCallback((note: NoteListItem) => {
    setSelectedNote(note)
    setIsDeleteDialogOpen(true)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedNote || isDeleting) return

    setIsDeleting(true)
    try {
      const success = await deleteNote(selectedNote.id)
      if (success) {
        // Close the tab if it's open
        closeTab(`/notes/${selectedNote.id}`)
      }
      setIsDeleteDialogOpen(false)
    } catch (err) {
      console.error("Failed to delete note:", err)
    } finally {
      setIsDeleting(false)
    }
  }, [selectedNote, isDeleting, deleteNote, closeTab])

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
  const renderNote = (note: NoteListItem, level: number, isLast: boolean) => (
    <TreeNode
      key={note.id}
      nodeId={note.id}
      level={level}
      isLast={isLast}
    >
      <TreeNodeTrigger
        contextMenuContent={
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
        }
      >
        <TreeExpander />
        <TreeIcon icon={<FileText className="h-4 w-4 text-muted-foreground" />} />
        <TreeLabel>{note.title}</TreeLabel>
      </TreeNodeTrigger>
    </TreeNode>
  )

  // Render folder with its contents
  const renderFolder = (
    folder: FolderNode,
    level: number,
    isLast: boolean
  ): ReactNode => {
    const hasChildren = folder.children.length > 0 || folder.notes.length > 0

    return (
      <TreeNode
        key={folder.path}
        nodeId={`folder-${folder.path}`}
        level={level}
        isLast={isLast}
      >
        <TreeNodeTrigger>
          <TreeExpander hasChildren={hasChildren} />
          <TreeIcon
            hasChildren={hasChildren}
            icon={<Folder className="h-4 w-4" />}
          />
          <TreeLabel>{folder.name}</TreeLabel>
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
    <div className="flex flex-col">
      {/* Header with New Note button */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Notes
        </span>
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
                <Plus className="h-3.5 w-3.5" />
              )}
              <span className="sr-only">New Note</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>Create new note</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Tree View */}
      <TreeProvider
        onSelectionChange={handleSelectionChange}
        draggable={false}
        animateExpand={true}
        multiSelect={false}
        indent={16}
      >
        <TreeView>
          {/* Root Notes Section */}
          {tree.rootNotes.length > 0 && (
            <TreeNode nodeId="notes-root">
              <TreeNodeTrigger>
                <TreeExpander hasChildren />
                <TreeIcon hasChildren />
                <TreeLabel>Notes</TreeLabel>
              </TreeNodeTrigger>
              <TreeNodeContent hasChildren>
                {tree.rootNotes.map((note, index) =>
                  renderNote(note, 1, index === tree.rootNotes.length - 1)
                )}
              </TreeNodeContent>
            </TreeNode>
          )}

          {/* Folders */}
          {tree.folders.map((folder, index) =>
            renderFolder(
              folder,
              0,
              index === tree.folders.length - 1 && tree.rootNotes.length === 0
            )
          )}

          {/* If no folders and no root notes section rendered, show flat list */}
          {tree.folders.length === 0 && tree.rootNotes.length === 0 && notes.length > 0 && (
            <>
              {notes.map((note, index) =>
                renderNote(note, 0, index === notes.length - 1)
              )}
            </>
          )}
        </TreeView>
      </TreeProvider>

      {/* Rename Dialog */}
      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Note</DialogTitle>
            <DialogDescription>
              Enter a new name for the note.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="note-title" className="sr-only">
              Note Title
            </Label>
            <Input
              id="note-title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Note title"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleRenameSubmit()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsRenameDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameSubmit}
              disabled={!newTitle.trim() || isRenaming}
            >
              {isRenaming ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Renaming...
                </>
              ) : (
                "Rename"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Note</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{selectedNote?.title}&quot;? This action cannot be undone.
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
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default NotesTree
