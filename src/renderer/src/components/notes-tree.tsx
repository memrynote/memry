'use client'

/**
 * NotesTree Component
 *
 * Displays real notes from the vault in a tree structure.
 * Replaces the hardcoded FileTree with data from useNotes() hook.
 */

import { useMemo, useCallback, useState, useRef, useEffect, type ReactNode } from 'react'
import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
  useTree,
  type MoveOperation,
  type DropPosition
} from '@/components/kibo-ui/tree'
import { useTabs } from '@/contexts/tabs'
import { useNotes, useNoteFolders, type NoteListItem } from '@/hooks/use-notes'
import { notesService } from '@/services/notes-service'
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
  LayoutTemplate,
  LayoutGrid,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { TemplateSelector } from '@/components/note/template-selector'
import { VirtualizedNotesTree } from '@/components/virtualized-notes-tree'
import { shouldVirtualize } from '@/lib/virtualized-tree-utils'

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
// Drag-Drop Helper Utilities
// ============================================================================

/**
 * Extract folder path from note path (removes filename and "notes/" prefix)
 */
function extractFolderFromPath(notePath: string): string {
  const parts = notePath.split('/')
  parts.pop() // Remove filename
  // Remove "notes" prefix if present
  if (parts.length > 0 && parts[0] === 'notes') {
    return parts.slice(1).join('/')
  }
  return parts.join('/')
}

/**
 * Get parent folder from folder path
 */
function getParentFolder(folderPath: string): string {
  const parts = folderPath.split('/')
  parts.pop()
  return parts.join('/')
}

/**
 * Check if moving folder into itself or its descendants (invalid operation)
 */
function isDescendantOrSelf(sourcePath: string, targetPath: string): boolean {
  return targetPath === sourcePath || targetPath.startsWith(sourcePath + '/')
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
    const parts = folderPath.split('/').filter(Boolean)
    let currentPath = ''

    parts.forEach((part) => {
      const parentPath = currentPath
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (!folderMap.has(currentPath)) {
        const node: FolderNode = {
          name: part,
          path: currentPath,
          children: [],
          notes: []
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
    const pathParts = note.path.split('/')
    pathParts.pop() // Remove filename

    if (pathParts.length === 0 || pathParts[0] === 'notes') {
      // Root level note (in notes/ folder directly)
      if (pathParts.length <= 1) {
        rootNotes.push(note)
      } else {
        // Note is in a subfolder
        const folderPath = pathParts.slice(1).join('/') // Remove "notes" prefix
        if (folderMap.has(folderPath)) {
          folderMap.get(folderPath)!.notes.push(note)
        } else {
          // Folder not in list, add note to root
          rootNotes.push(note)
        }
      }
    } else {
      // Note path doesn't start with "notes/"
      const folderPath = pathParts.join('/')
      if (folderMap.has(folderPath)) {
        folderMap.get(folderPath)!.notes.push(note)
      } else {
        rootNotes.push(note)
      }
    }
  })

  // Get root-level folders (no parent)
  const rootFolders = Array.from(folderMap.values()).filter((folder) => {
    return !folder.path.includes('/')
  })

  return {
    folders: rootFolders,
    rootNotes
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

function NotesTreeEmpty({
  onCreateNote,
  isCreating
}: {
  onCreateNote: () => void
  isCreating: boolean
}) {
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
  // Load all notes so the tree can correctly show files in all folders
  // Tree views need complete data - pagination doesn't make sense here
  // Virtualization (enabled at 100+ items) handles render performance
  const { notes, isLoading, error, createNote, deleteNote, renameNote, moveNote } = useNotes({
    autoLoad: true,
    limit: 10000
  })
  const { folders, createFolder, refresh: refreshFolders } = useNoteFolders()
  const { openTab, closeTab } = useTabs()
  const [isCreating, setIsCreating] = useState(false)
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [isMoving, setIsMoving] = useState(false)

  // Multi-selection state (controlled mode)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // Dialog state for single/bulk delete
  const [notesToDelete, setNotesToDelete] = useState<NoteListItem[]>([])
  const [foldersToDelete, setFoldersToDelete] = useState<string[]>([])
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Inline rename state for notes
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)

  // Inline rename state for folders
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [isFolderRenaming, setIsFolderRenaming] = useState(false)
  const folderRenameInputRef = useRef<HTMLInputElement>(null)

  // Folder template configuration state
  const [folderToConfigureTemplate, setFolderToConfigureTemplate] = useState<string | null>(null)
  const [folderTemplateNames, setFolderTemplateNames] = useState<Map<string, string>>(new Map())

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

  // Load folder template names on mount/folder change
  useEffect(() => {
    const loadFolderTemplateNames = async () => {
      if (folders.length === 0) return

      try {
        // Fetch templates list once
        const templatesResponse = await window.api.templates.list()
        const templatesMap = new Map(templatesResponse.templates.map((t) => [t.id, t.name]))

        // Fetch configs for all folders and build names map
        const namesMap = new Map<string, string>()
        await Promise.all(
          folders.map(async (folderPath) => {
            try {
              const config = await notesService.getFolderConfig(folderPath)
              if (config?.template) {
                const templateName = templatesMap.get(config.template)
                if (templateName) {
                  namesMap.set(folderPath, templateName)
                }
              }
            } catch {
              // Ignore errors for individual folders
            }
          })
        )

        setFolderTemplateNames(namesMap)
      } catch (err) {
        console.error('Failed to load folder template names:', err)
      }
    }

    loadFolderTemplateNames()
  }, [folders])

  // Build tree structure from notes and folders
  const tree = useMemo(() => {
    return buildTreeFromNotes(notes, folders)
  }, [notes, folders])

  // Check if we should use virtualized rendering (100+ items)
  const useVirtualization = useMemo(() => {
    return shouldVirtualize(tree)
  }, [tree])

  // Map of noteId to note for quick lookup
  const noteMap = useMemo(() => {
    const map = new Map<string, NoteListItem>()
    notes.forEach((note) => map.set(note.id, note))
    return map
  }, [notes])

  // Compute target folder from selection (for creating notes/folders in context)
  const targetFolder = useMemo(() => {
    if (selectedIds.length === 0) return '' // root

    const selectedId = selectedIds[0]

    // If folder selected, use its path
    if (selectedId.startsWith('folder-')) {
      return selectedId.replace('folder-', '')
    }

    // If note selected, get its parent folder
    const note = noteMap.get(selectedId)
    if (note) {
      const parts = note.path.split('/')
      parts.pop() // remove filename
      // If path is "notes/subfolder/file.md", after pop we have ["notes", "subfolder"]
      // We want "subfolder" (remove the "notes" prefix)
      if (parts.length > 1 && parts[0] === 'notes') {
        return parts.slice(1).join('/')
      }
      return '' // root notes folder
    }

    return ''
  }, [selectedIds, noteMap])

  // Handle note selection - update state and optionally open in tab
  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      // Keep all IDs including folders for context-aware creation
      setSelectedIds(ids)

      // Only open in tab on single note selection (not folders, not multi-select)
      const noteIds = ids.filter((id) => !id.startsWith('folder-') && id !== 'notes-root')
      if (noteIds.length === 1) {
        const note = noteMap.get(noteIds[0])
        if (note) {
          openTab({
            type: 'note',
            title: getDisplayName(note.path),
            icon: 'file-text',
            emoji: note.emoji,
            path: `/notes/${note.id}`,
            entityId: note.id,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false
          })
        }
      }
    },
    [noteMap, openTab]
  )

  // Handle opening folder view from hover icon
  const handleOpenFolderView = useCallback(
    (folderPath: string) => {
      const folderName = folderPath.split('/').pop() || 'Folder'
      openTab({
        type: 'folder',
        title: folderName,
        icon: 'folder',
        path: `/folder/${encodeURIComponent(folderPath)}`,
        entityId: folderPath,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab]
  )

  // Handle creating a new note - uses folder default template automatically
  const handleCreateNote = useCallback(async () => {
    if (isCreating) return

    setIsCreating(true)
    try {
      // Get folder's default template (if any)
      const templateId = targetFolder ? await notesService.getFolderTemplate(targetFolder) : null

      const newNote = await createNote({
        title: 'Untitled',
        folder: targetFolder || undefined,
        template: templateId ?? undefined
        // Note: content is intentionally omitted to allow template content to be used
      })

      if (newNote) {
        // Open the new note in a tab
        openTab({
          type: 'note',
          title: getDisplayName(newNote.path),
          icon: 'file-text',
          emoji: newNote.emoji,
          path: `/notes/${newNote.id}`,
          entityId: newNote.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })

        // Auto-focus rename mode for the new note
        setRenamingNoteId(newNote.id)
        setRenameValue('Untitled')
      }
    } catch (err) {
      console.error('Failed to create note:', err)
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, createNote, openTab, targetFolder])

  // Handle opening template selector for folder configuration
  const handleSetFolderTemplate = useCallback((folderPath: string) => {
    setFolderToConfigureTemplate(folderPath)
  }, [])

  // Handle template selection for folder configuration
  const handleFolderTemplateSelect = useCallback(
    async (templateId: string | null) => {
      if (folderToConfigureTemplate && templateId) {
        try {
          await notesService.setFolderConfig(folderToConfigureTemplate, {
            template: templateId,
            inherit: true
          })
          // Update cached template name
          const templatesResponse = await window.api.templates.list()
          const template = templatesResponse.templates.find((t) => t.id === templateId)
          if (template) {
            setFolderTemplateNames((prev) => {
              const next = new Map(prev)
              next.set(folderToConfigureTemplate, template.name)
              return next
            })
          }
          toast.success('Default template set')
        } catch (err) {
          console.error('Failed to set folder template:', err)
          toast.error('Failed to set default template')
        }
      }
      setFolderToConfigureTemplate(null)
    },
    [folderToConfigureTemplate]
  )

  // Handle clearing folder default template
  const handleClearFolderTemplate = useCallback(async (folderPath: string) => {
    try {
      await notesService.setFolderConfig(folderPath, {
        template: undefined,
        inherit: true
      })
      // Remove from cached template names
      setFolderTemplateNames((prev) => {
        const next = new Map(prev)
        next.delete(folderPath)
        return next
      })
      toast.success('Default template cleared')
    } catch (err) {
      console.error('Failed to clear folder template:', err)
      toast.error('Failed to clear default template')
    }
  }, [])

  // Handle creating a new folder (in target folder)
  const handleCreateFolder = useCallback(async () => {
    if (isCreatingFolder) return

    setIsCreatingFolder(true)
    try {
      // Generate unique folder name
      const baseName = 'Untitled Folder'
      let folderName = baseName
      let counter = 1
      const targetPath = targetFolder ? `${targetFolder}/` : ''

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
      console.error('Failed to create folder:', err)
    } finally {
      setIsCreatingFolder(false)
    }
  }, [isCreatingFolder, createFolder, folders, targetFolder, refreshFolders])

  // Handle creating a note in a specific folder (from context menu)
  const handleCreateNoteInFolder = useCallback(
    async (folderPath: string) => {
      if (isCreating) return

      setIsCreating(true)
      try {
        // Get folder's default template (if any)
        const templateId = await notesService.getFolderTemplate(folderPath)

        const newNote = await createNote({
          title: 'Untitled',
          folder: folderPath || undefined,
          template: templateId ?? undefined
          // Note: content is intentionally omitted to allow template content to be used
        })

        if (newNote) {
          openTab({
            type: 'note',
            title: getDisplayName(newNote.path),
            icon: 'file-text',
            emoji: newNote.emoji,
            path: `/notes/${newNote.id}`,
            entityId: newNote.id,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
        }
      } catch (err) {
        console.error('Failed to create note:', err)
      } finally {
        setIsCreating(false)
      }
    },
    [isCreating, createNote, openTab]
  )

  // Handle creating a subfolder in a specific folder (from context menu)
  const handleCreateSubfolder = useCallback(
    async (parentPath: string) => {
      if (isCreatingFolder) return

      setIsCreatingFolder(true)
      try {
        const baseName = 'Untitled Folder'
        let folderName = baseName
        let counter = 1
        const targetPath = parentPath ? `${parentPath}/` : ''

        while (folders.includes(`${targetPath}${folderName}`)) {
          folderName = `${baseName} ${counter++}`
        }

        const fullPath = `${targetPath}${folderName}`
        const success = await createFolder(fullPath)

        if (success) {
          await refreshFolders()
        }
      } catch (err) {
        console.error('Failed to create folder:', err)
      } finally {
        setIsCreatingFolder(false)
      }
    },
    [isCreatingFolder, createFolder, folders, refreshFolders]
  )

  // Context menu action handlers
  const handleRenameClick = useCallback((note: NoteListItem) => {
    setRenamingNoteId(note.id)
    setRenameValue(getDisplayName(note.path))
  }, [])

  const handleRenameSubmit = useCallback(
    async (noteId: string, originalPath: string) => {
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
        console.error('Failed to rename note:', err)
      } finally {
        setIsRenaming(false)
        setRenamingNoteId(null)
      }
    },
    [renameValue, isRenaming, renameNote]
  )

  const handleRenameCancel = useCallback(() => {
    setRenamingNoteId(null)
    setRenameValue('')
  }, [])

  // Folder rename handlers
  const handleRenameFolderClick = useCallback((folderPath: string) => {
    setRenamingFolderPath(folderPath)
    const folderName = folderPath.split('/').pop() || folderPath
    setFolderRenameValue(folderName)
  }, [])

  const handleFolderRenameSubmit = useCallback(
    async (oldPath: string) => {
      if (!folderRenameValue.trim() || isFolderRenaming) {
        setRenamingFolderPath(null)
        return
      }

      const oldName = oldPath.split('/').pop() || oldPath
      if (folderRenameValue.trim() === oldName) {
        setRenamingFolderPath(null)
        return
      }

      setIsFolderRenaming(true)
      try {
        // Build new path: replace last segment with new name
        const parentPath = oldPath.includes('/')
          ? oldPath.substring(0, oldPath.lastIndexOf('/'))
          : ''
        const newPath = parentPath
          ? `${parentPath}/${folderRenameValue.trim()}`
          : folderRenameValue.trim()

        await notesService.renameFolder(oldPath, newPath)
        await refreshFolders()
      } catch (err) {
        console.error('Failed to rename folder:', err)
      } finally {
        setIsFolderRenaming(false)
        setRenamingFolderPath(null)
      }
    },
    [folderRenameValue, isFolderRenaming, refreshFolders]
  )

  const handleFolderRenameCancel = useCallback(() => {
    setRenamingFolderPath(null)
    setFolderRenameValue('')
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
      if (id.startsWith('folder-')) {
        // Extract folder path from "folder-path/to/folder" format
        const folderPath = id.replace('folder-', '')
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
      console.error('Failed to delete items:', err)
    } finally {
      setIsDeleting(false)
    }
  }, [notesToDelete, foldersToDelete, isDeleting, deleteNote, closeTab, refreshFolders])

  const handleOpenExternal = useCallback(async (note: NoteListItem) => {
    try {
      await notesService.openExternal(note.id)
    } catch (err) {
      console.error('Failed to open note externally:', err)
    }
  }, [])

  const handleRevealInFinder = useCallback(async (note: NoteListItem) => {
    try {
      await notesService.revealInFinder(note.id)
    } catch (err) {
      console.error('Failed to reveal note in Finder:', err)
    }
  }, [])

  // ============================================================================
  // Drag-Drop Move Handlers
  // ============================================================================

  /**
   * Calculate the target folder from a drop operation
   */
  const calculateTargetFolder = useCallback(
    (targetId: string, position: DropPosition): string => {
      // Root drop
      if (targetId === 'notes-root' || targetId === '') {
        return ''
      }

      // Dropped on a folder
      if (targetId.startsWith('folder-')) {
        const folderPath = targetId.replace('folder-', '')
        if (position === 'inside') {
          return folderPath
        } else {
          // Before/after a folder - target is the parent folder
          return getParentFolder(folderPath)
        }
      }

      // Dropped on a note - get that note's folder
      const targetNote = noteMap.get(targetId)
      if (targetNote) {
        return extractFolderFromPath(targetNote.path)
      }

      return ''
    },
    [noteMap]
  )

  /**
   * Handle moving a single note to a folder
   */
  const handleNoteMove = useCallback(
    async (noteId: string, targetFolder: string): Promise<boolean> => {
      // Get the note to check current folder
      const note = noteMap.get(noteId)
      if (!note) return false

      // Check if already in target folder
      const currentFolder = extractFolderFromPath(note.path)
      if (currentFolder === targetFolder) {
        return false // No-op
      }

      try {
        await moveNote(noteId, targetFolder)
        return true
      } catch (err) {
        console.error('Failed to move note:', err)
        return false
      }
    },
    [noteMap, moveNote]
  )

  /**
   * Handle moving a folder into another folder
   */
  const handleFolderMove = useCallback(
    async (
      sourceFolderPath: string,
      targetId: string,
      position: DropPosition
    ): Promise<boolean> => {
      const sourceFolderName = sourceFolderPath.split('/').pop() || sourceFolderPath

      let newPath = ''

      if (targetId === 'notes-root' || targetId === '') {
        // Move to root level
        newPath = sourceFolderName
      } else if (targetId.startsWith('folder-')) {
        const targetPath = targetId.replace('folder-', '')

        // Prevent invalid moves (into self or descendants)
        if (isDescendantOrSelf(sourceFolderPath, targetPath)) {
          console.warn('Cannot move folder into itself or its descendants')
          return false
        }

        if (position === 'inside') {
          // Move into target folder
          newPath = `${targetPath}/${sourceFolderName}`
        } else {
          // Before/after target - move to target's parent
          const parentFolder = getParentFolder(targetPath)
          newPath = parentFolder ? `${parentFolder}/${sourceFolderName}` : sourceFolderName
        }
      } else {
        // Dropped on a note - get that note's folder
        const targetNote = noteMap.get(targetId)
        if (targetNote) {
          const targetFolder = extractFolderFromPath(targetNote.path)
          newPath = targetFolder ? `${targetFolder}/${sourceFolderName}` : sourceFolderName
        } else {
          newPath = sourceFolderName
        }
      }

      // Skip if already at target
      if (newPath === sourceFolderPath) {
        return false
      }

      try {
        await notesService.renameFolder(sourceFolderPath, newPath)
        await refreshFolders()
        return true
      } catch (err) {
        console.error('Failed to move folder:', err)
        return false
      }
    },
    [noteMap, refreshFolders]
  )

  /**
   * Main move handler called when drag-drop completes
   * Supports multi-selection: all selected items are moved together
   */
  const handleMove = useCallback(
    async (operation: MoveOperation) => {
      if (isMoving) return // Prevent concurrent moves

      const { draggedId, targetId, position } = operation

      // Don't allow dropping on self
      if (draggedId === targetId) return

      setIsMoving(true)

      try {
        // Check if dragged item is part of multi-selection
        const isPartOfSelection = selectedIds.includes(draggedId)
        const itemsToMove =
          isPartOfSelection && selectedIds.length > 1
            ? selectedIds.filter((id) => id !== targetId) // Exclude target from items to move
            : [draggedId]

        // Separate notes and folders
        const notesToMove: string[] = []
        const foldersToMove: string[] = []

        for (const id of itemsToMove) {
          if (id.startsWith('folder-')) {
            foldersToMove.push(id.replace('folder-', ''))
          } else {
            notesToMove.push(id)
          }
        }

        // Calculate target folder for notes
        const targetFolder = calculateTargetFolder(targetId, position)

        // Move folders first (to avoid issues if notes are inside folders being moved)
        for (const folderPath of foldersToMove) {
          await handleFolderMove(folderPath, targetId, position)
        }

        // Move notes
        for (const noteId of notesToMove) {
          await handleNoteMove(noteId, targetFolder)
        }

        // Clear selection after successful move
        if (itemsToMove.length > 1) {
          setSelectedIds([])
        }
      } finally {
        setIsMoving(false)
      }
    },
    [isMoving, selectedIds, calculateTargetFolder, handleNoteMove, handleFolderMove]
  )

  // Handle Delete key to delete selected notes
  useEffect(() => {
    const container = treeContainerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if we're renaming
      if (renamingNoteId) return

      // Delete or Backspace key
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        // Make sure we're focused on the tree, not an input
        const activeElement = document.activeElement
        if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA') {
          return
        }

        e.preventDefault()
        handleBulkDelete()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds, renamingNoteId, handleBulkDelete])

  // State for pending reveal request (set from outside, handled inside TreeProvider)
  const [pendingRevealNoteId, setPendingRevealNoteId] = useState<string | null>(null)

  // Handle "Reveal in Sidebar" events from tab context menu
  useEffect(() => {
    const handleRevealInSidebar = (event: CustomEvent<{ path: string; entityId?: string }>) => {
      const { entityId } = event.detail

      // Find the note by entityId
      if (!entityId) return
      const note = noteMap.get(entityId)
      if (!note) return

      // Expand the Collections section in sidebar by updating localStorage
      try {
        localStorage.setItem('sidebar-section-collections-expanded', 'true')
        // Dispatch storage event to trigger re-render in SidebarSection
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'sidebar-section-collections-expanded',
            newValue: 'true'
          })
        )
      } catch {
        // Ignore localStorage errors
      }

      // Set pending reveal - will be handled by RevealHandler inside TreeProvider
      setPendingRevealNoteId(entityId)
    }

    window.addEventListener('reveal-in-sidebar', handleRevealInSidebar as EventListener)
    return () => {
      window.removeEventListener('reveal-in-sidebar', handleRevealInSidebar as EventListener)
    }
  }, [noteMap])

  // Helper component that runs inside TreeProvider to handle folder expansion
  const RevealHandler = useCallback(() => {
    const { expandNode } = useTree()

    useEffect(() => {
      if (!pendingRevealNoteId) return

      const note = noteMap.get(pendingRevealNoteId)
      if (!note) {
        setPendingRevealNoteId(null)
        return
      }

      // Extract folder path from note path to expand parent folders
      const pathParts = note.path.split('/')
      pathParts.pop() // Remove filename

      // If note is in a subfolder, expand all parent folders
      if (pathParts.length > 1) {
        const folderParts = pathParts.slice(1) // Remove "notes" prefix
        let currentPath = ''
        for (const part of folderParts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part
          // Expand this folder
          expandNode(`folder-${currentPath}`)
        }
      }

      // Select the note and scroll to it
      setTimeout(() => {
        setSelectedIds([pendingRevealNoteId])

        // Scroll the note into view
        setTimeout(() => {
          const element = document.querySelector(`[data-tree-node-id="${pendingRevealNoteId}"]`)
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' })
            // Add a brief highlight effect
            element.classList.add('bg-accent')
            setTimeout(() => {
              element.classList.remove('bg-accent')
            }, 2000)
          }
        }, 100)

        // Clear pending reveal
        setPendingRevealNoteId(null)
      }, 50)
    }, [pendingRevealNoteId, expandNode])

    return null
  }, [pendingRevealNoteId, noteMap])

  // Render action buttons (must be before early returns to follow Rules of Hooks)
  const actionButtons = useMemo(
    () => (
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
            <p>New note{targetFolder ? ` in ${targetFolder}` : ''}</p>
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
            <p>New folder{targetFolder ? ` in ${targetFolder}` : ''}</p>
          </TooltipContent>
        </Tooltip>
      </>
    ),
    [handleCreateNote, handleCreateFolder, isCreating, isCreatingFolder, targetFolder]
  )

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

  // Render empty state (only if no notes AND no folders)
  if (notes.length === 0 && folders.length === 0) {
    return <NotesTreeEmpty onCreateNote={handleCreateNote} isCreating={isCreating} />
  }

  // Render note item with context menu
  const renderNote = (note: NoteListItem, level: number, isLast: boolean) => {
    const isBeingRenamed = renamingNoteId === note.id
    const isSelected = selectedIds.includes(note.id)
    const hasMultipleSelected = selectedIds.length > 1
    const isPartOfSelection = isSelected && hasMultipleSelected

    return (
      <TreeNode key={note.id} nodeId={note.id} level={level} isLast={isLast}>
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
                  <ContextMenuItem variant="destructive" onClick={() => handleDeleteClick(note)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </>
              )}
              {/* Bulk actions - show when part of multi-select */}
              {isPartOfSelection && (
                <ContextMenuItem variant="destructive" onClick={handleBulkDelete}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete {selectedIds.length} Notes
                </ContextMenuItem>
              )}
            </>
          }
        >
          <TreeExpander />
          <TreeIcon
            icon={
              note.emoji ? (
                <span className="text-sm leading-none" role="img" aria-label="note icon">
                  {note.emoji}
                </span>
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground" />
              )
            }
          />
          {isBeingRenamed ? (
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleRenameSubmit(note.id, note.path)
                } else if (e.key === 'Escape') {
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
  const renderFolder = (folder: FolderNode, level: number, isLast: boolean): ReactNode => {
    const hasChildren = folder.children.length > 0 || folder.notes.length > 0
    const isBeingRenamed = renamingFolderPath === folder.path

    return (
      <TreeNode key={folder.path} nodeId={`folder-${folder.path}`} level={level} isLast={isLast}>
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
              <ContextMenuItem onClick={() => handleSetFolderTemplate(folder.path)}>
                <LayoutTemplate className="mr-2 h-4 w-4" />
                Set Default Template
                {folderTemplateNames.get(folder.path) && (
                  <span className="ml-1 text-muted-foreground">
                    ({folderTemplateNames.get(folder.path)})
                  </span>
                )}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => handleClearFolderTemplate(folder.path)}>
                <X className="mr-2 h-4 w-4" />
                Clear Default Template
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
          <TreeIcon hasChildren={hasChildren} icon={<Folder className="h-4 w-4" />} />
          {isBeingRenamed ? (
            <input
              ref={folderRenameInputRef}
              type="text"
              value={folderRenameValue}
              onChange={(e) => setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleFolderRenameSubmit(folder.path)
                } else if (e.key === 'Escape') {
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
            <div className="group/folder flex flex-1 items-center">
              <TreeLabel className="flex-1">{folder.name}</TreeLabel>
              {/* Hover action icon to open folder view */}
              <div className="flex items-center opacity-0 group-hover/folder:opacity-100 transition-opacity ml-auto">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleOpenFolderView(folder.path)
                  }}
                  className="p-1 cursor-pointer rounded hover:bg-accent/80 transition-colors"
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
              renderNote(note, level + 1, index === folder.notes.length - 1)
            )}
          </TreeNodeContent>
        )}
      </TreeNode>
    )
  }

  return (
    <div ref={treeContainerRef} className="flex flex-col h-full" tabIndex={-1}>
      {/* Use virtualized tree for 100+ items, otherwise use standard tree */}
      {useVirtualization ? (
        <VirtualizedNotesTree
          tree={tree}
          selectedIds={selectedIds}
          onSelectionChange={handleSelectionChange}
          onRenameNote={handleRenameClick}
          onDeleteNote={handleDeleteClick}
          onOpenExternal={handleOpenExternal}
          onRevealInFinder={handleRevealInFinder}
          onCreateNote={handleCreateNoteInFolder}
          onCreateFolder={handleCreateSubfolder}
          onRenameFolder={handleRenameFolderClick}
          onDeleteFolder={handleDeleteFolderClick}
          onSetFolderTemplate={handleSetFolderTemplate}
          onClearFolderTemplate={handleClearFolderTemplate}
          folderTemplateNames={folderTemplateNames}
          noteMap={noteMap}
          isDragDisabled={!!renamingNoteId || !!renamingFolderPath || isMoving}
          className="flex-1"
        />
      ) : (
        <TreeProvider
          selectedIds={selectedIds}
          onSelectionChange={handleSelectionChange}
          draggable={!renamingNoteId && !renamingFolderPath && !isMoving}
          onMove={handleMove}
          animateExpand={true}
          multiSelect={true}
          indent={16}
        >
          {/* Handle reveal-in-sidebar requests */}
          <RevealHandler />
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
              renderNote(note, 0, index === tree.rootNotes.length - 1)
            )}
          </TreeView>
        </TreeProvider>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {(() => {
                const totalItems = notesToDelete.length + foldersToDelete.length
                if (totalItems === 1) {
                  if (foldersToDelete.length === 1) return 'Delete Folder'
                  return 'Delete Note'
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
                    const folderName = foldersToDelete[0].split('/').pop() || foldersToDelete[0]
                    return (
                      <>
                        Are you sure you want to delete the folder &quot;{folderName}&quot; and all
                        its contents? This action cannot be undone.
                      </>
                    )
                  }
                  return (
                    <>
                      Are you sure you want to delete &quot;
                      {getDisplayName(notesToDelete[0]?.path || '')}&quot;? This action cannot be
                      undone.
                    </>
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
                          {folderPath.split('/').pop() || folderPath} (folder)
                        </li>
                      ))}
                      {notesToDelete
                        .slice(0, 5 - Math.min(foldersToDelete.length, 3))
                        .map((note) => (
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
              ) : notesToDelete.length + foldersToDelete.length === 1 ? (
                'Delete'
              ) : (
                `Delete ${notesToDelete.length + foldersToDelete.length}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Template Selector Dialog for Folder Configuration */}
      <TemplateSelector
        isOpen={folderToConfigureTemplate !== null}
        onClose={() => setFolderToConfigureTemplate(null)}
        onSelect={handleFolderTemplateSelect}
      />
    </div>
  )
}

export default NotesTree
