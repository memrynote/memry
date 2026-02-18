'use client'

/**
 * NotesTree Component
 *
 * Displays real notes from the vault in a tree structure.
 * Replaces the hardcoded FileTree with data from useNotes() hook.
 */

import { useMemo, useCallback, useState, useRef, useEffect, type ReactNode } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
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
import { useQueryClient } from '@tanstack/react-query'
import { useTabActions } from '@/contexts/tabs'
import { notesKeys } from '@/hooks/use-notes-query'
import type { Note } from '@shared/contracts/notes-api'
import {
  useNotesList,
  useNoteFoldersQuery,
  useNoteMutations,
  type NoteListItem
} from '@/hooks/use-notes-query'
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
  Import,
  LayoutTemplate,
  LayoutGrid,
  X,
  FileType2,
  Image,
  Music,
  Video
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
import { getTabIconForFileType, type FileType } from '@shared/file-types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:NotesTree')

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
  // Remove any extension (not just .md)
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}

/**
 * Get the appropriate icon component for a file based on its type.
 * Returns the icon element to render in the tree.
 */
function getFileIcon(note: NoteListItem): React.ReactElement {
  // Emoji takes priority for markdown files
  if (note.emoji) {
    return (
      <span className="text-sm leading-none" role="img" aria-label="note icon">
        {note.emoji}
      </span>
    )
  }

  // Get icon based on file type
  const fileType = note.fileType ?? 'markdown'
  const iconClass = 'h-4 w-4 text-muted-foreground'

  switch (fileType) {
    case 'pdf':
      return <FileType2 className={`${iconClass} text-red-500`} />
    case 'image':
      return <Image className={`${iconClass} text-blue-500`} />
    case 'audio':
      return <Music className={`${iconClass} text-green-500`} />
    case 'video':
      return <Video className={`${iconClass} text-purple-500`} />
    case 'markdown':
    default:
      return <FileText className={iconClass} />
  }
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

/**
 * Get notes in a specific folder from tree structure
 */
function getNotesInFolder(tree: TreeStructure, folderPath: string): NoteListItem[] {
  if (folderPath === '') {
    return tree.rootNotes
  }

  const findFolder = (folders: FolderNode[], path: string): FolderNode | null => {
    for (const folder of folders) {
      if (folder.path === path) return folder
      const found = findFolder(folder.children, path)
      if (found) return found
    }
    return null
  }

  const folder = findFolder(tree.folders, folderPath)
  return folder ? folder.notes : []
}

/**
 * Get sibling folders in a specific parent folder from tree structure
 * @param tree The tree structure
 * @param parentPath The parent folder path (empty string for root level)
 * @returns Array of folder paths in the parent
 */
function getFoldersInParent(tree: TreeStructure, parentPath: string): string[] {
  if (parentPath === '') {
    // Root level folders
    return tree.folders.map((f) => f.path)
  }

  const findFolder = (folders: FolderNode[], path: string): FolderNode | null => {
    for (const folder of folders) {
      if (folder.path === path) return folder
      const found = findFolder(folder.children, path)
      if (found) return found
    }
    return null
  }

  const parentFolder = findFolder(tree.folders, parentPath)
  return parentFolder ? parentFolder.children.map((f) => f.path) : []
}

// ============================================================================
// Tree Building Utilities
// ============================================================================

/**
 * Build a tree structure from flat notes list and folders.
 * Positions map is used to sort notes within each folder.
 */
function buildTreeFromNotes(
  notes: NoteListItem[],
  folders: string[],
  positions: Record<string, number>
): TreeStructure {
  const folderMap = new Map<string, FolderNode>()
  const rootNotes: NoteListItem[] = []

  const ensureFolderInMap = (folderPath: string): FolderNode => {
    const existing = folderMap.get(folderPath)
    if (existing) return existing

    const parts = folderPath.split('/').filter(Boolean)
    let currentPath = ''

    let lastNode: FolderNode | undefined
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

        if (parentPath && folderMap.has(parentPath)) {
          const parent = folderMap.get(parentPath)!
          if (!parent.children.some((c) => c.path === currentPath)) {
            parent.children.push(node)
          }
        }
        lastNode = node
      } else {
        lastNode = folderMap.get(currentPath)!
      }
    })

    return lastNode!
  }

  folders.forEach((folderPath) => {
    ensureFolderInMap(folderPath)
  })

  notes.forEach((note) => {
    const pathParts = note.path.split('/')
    pathParts.pop()

    if (pathParts.length === 0 || pathParts[0] === 'notes') {
      if (pathParts.length <= 1) {
        rootNotes.push(note)
      } else {
        const folderPath = pathParts.slice(1).join('/')
        ensureFolderInMap(folderPath).notes.push(note)
      }
    } else {
      const folderPath = pathParts.join('/')
      ensureFolderInMap(folderPath).notes.push(note)
    }
  })

  const sortByPosition = (a: NoteListItem, b: NoteListItem): number => {
    const posA = positions[a.path] ?? Number.MAX_SAFE_INTEGER
    const posB = positions[b.path] ?? Number.MAX_SAFE_INTEGER
    if (posA !== posB) return posA - posB
    return b.modified.getTime() - a.modified.getTime()
  }

  const sortFoldersByPosition = (a: FolderNode, b: FolderNode): number => {
    const posA = positions[a.path] ?? Number.MAX_SAFE_INTEGER
    const posB = positions[b.path] ?? Number.MAX_SAFE_INTEGER
    if (posA !== posB) return posA - posB
    return a.name.localeCompare(b.name)
  }

  rootNotes.sort(sortByPosition)

  const sortFolderContents = (folder: FolderNode): void => {
    folder.notes.sort(sortByPosition)
    folder.children.sort(sortFoldersByPosition)
    folder.children.forEach(sortFolderContents)
  }

  const rootFolders = Array.from(folderMap.values()).filter((folder) => {
    return !folder.path.includes('/')
  })

  rootFolders.sort(sortFoldersByPosition)
  rootFolders.forEach(sortFolderContents)

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
  const { notes, isLoading, error } = useNotesList({ limit: 10000 })
  const mutations = useNoteMutations()
  // Extract stable mutateAsync functions to avoid infinite re-render loops
  // (useMutation returns unstable object references when mutation state changes)
  const createNoteMutateAsync = mutations.createNote.mutateAsync
  const deleteNoteMutateAsync = mutations.deleteNote.mutateAsync
  const renameNoteMutateAsync = mutations.renameNote.mutateAsync
  const moveNoteMutateAsync = mutations.moveNote.mutateAsync
  const { folders, createFolder, refetch: refreshFolders } = useNoteFoldersQuery()
  const { openTab, closeTab, updateTabTitleByEntityId } = useTabActions()
  const queryClient = useQueryClient()
  const originalRenameTitle = useRef<string>('')
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
  const [isTreeFocused, setIsTreeFocused] = useState(false)
  const isTreeFocusedRef = useRef(false)

  // Inline rename state for folders
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [isFolderRenaming, setIsFolderRenaming] = useState(false)
  const folderRenameInputRef = useRef<HTMLInputElement>(null)

  // Folder template configuration state
  const [folderToConfigureTemplate, setFolderToConfigureTemplate] = useState<string | null>(null)
  const [folderTemplateNames, setFolderTemplateNames] = useState<Map<string, string>>(new Map())

  // Note positions for custom ordering
  const [notePositions, setNotePositions] = useState<Record<string, number>>({})

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
        log.error('Failed to load folder template names', err)
      }
    }

    loadFolderTemplateNames()
  }, [folders])

  // Fetch positions when notes change
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const result = await notesService.getAllPositions()
        if (result.success) {
          setNotePositions(result.positions)
        }
      } catch (err) {
        log.error('Failed to fetch positions', err)
      }
    }
    fetchPositions()
  }, [notes])

  // Build tree structure from notes, folders, and positions
  const tree = useMemo(() => {
    return buildTreeFromNotes(notes, folders, notePositions)
  }, [notes, folders, notePositions])

  // Map of noteId to note for quick lookup
  const noteMap = useMemo(() => {
    const map = new Map<string, NoteListItem>()
    notes.forEach((note) => map.set(note.id, note))
    return map
  }, [notes])

  // Compute target folder from selection — only when tree is focused so toolbar
  // buttons create at root when the user clicks away from the tree
  const targetFolder = useMemo(() => {
    if (!isTreeFocused) return ''
    if (selectedIds.length === 0) return ''

    const selectedId = selectedIds[0]

    if (selectedId.startsWith('folder-')) {
      return selectedId.replace('folder-', '')
    }

    const note = noteMap.get(selectedId)
    if (note) {
      const parts = note.path.split('/')
      parts.pop()
      if (parts.length > 1 && parts[0] === 'notes') {
        return parts.slice(1).join('/')
      }
      return ''
    }

    return ''
  }, [selectedIds, noteMap, isTreeFocused])

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
          const fileType = (note.fileType ?? 'markdown') as FileType
          const isMarkdown = fileType === 'markdown'

          openTab({
            type: isMarkdown ? 'note' : 'file',
            title: getDisplayName(note.path),
            icon: getTabIconForFileType(fileType),
            emoji: isMarkdown ? note.emoji : undefined,
            path: isMarkdown ? `/notes/${note.id}` : `/file/${note.id}`,
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

    const folder = isTreeFocusedRef.current ? targetFolder : ''

    setIsCreating(true)
    try {
      const templateId = folder ? await notesService.getFolderTemplate(folder) : null

      const result = await createNoteMutateAsync({
        title: 'Untitled',
        folder: folder || undefined,
        template: templateId ?? undefined
      })

      if (result.success && result.note) {
        const newNote = result.note
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

        originalRenameTitle.current = 'Untitled'
        setRenamingNoteId(newNote.id)
        setRenameValue('Untitled')
      }
    } catch (err) {
      log.error('Failed to create note', err)
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, createNoteMutateAsync, openTab, targetFolder])

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
          log.error('Failed to set folder template', err)
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
      log.error('Failed to clear folder template', err)
      toast.error('Failed to clear default template')
    }
  }, [])

  // Handle creating a new folder (in target folder)
  const handleCreateFolder = useCallback(async () => {
    if (isCreatingFolder) return

    const folder = isTreeFocusedRef.current ? targetFolder : ''

    setIsCreatingFolder(true)
    try {
      const baseName = 'Untitled Folder'
      let folderName = baseName
      let counter = 1
      const targetPath = folder ? `${folder}/` : ''

      while (folders.includes(`${targetPath}${folderName}`)) {
        folderName = `${baseName} ${counter++}`
      }

      const fullPath = `${targetPath}${folderName}`
      const success = await createFolder(fullPath)

      if (success) {
        await refreshFolders()
        setRenamingFolderPath(fullPath)
        setFolderRenameValue(folderName)
      }
    } catch (err) {
      log.error('Failed to create folder', err)
    } finally {
      setIsCreatingFolder(false)
    }
  }, [isCreatingFolder, createFolder, folders, targetFolder, refreshFolders])

  const handleImportFiles = useCallback(async () => {
    const folder = isTreeFocusedRef.current ? targetFolder : ''
    try {
      const dialogResult = await notesService.showImportDialog()
      if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
        return
      }

      const result = await notesService.importFiles(dialogResult.filePaths, folder || '')

      if (result.imported > 0) {
        toast.success(`Imported ${result.imported} file${result.imported > 1 ? 's' : ''}`)
      }

      if (result.failed > 0) {
        toast.error(`Failed to import ${result.failed} file${result.failed > 1 ? 's' : ''}`, {
          description: result.errors.join('\n')
        })
      }
    } catch (err) {
      log.error('Failed to import files', err)
      toast.error('Failed to import files')
    }
  }, [targetFolder])

  // Handle creating a note in a specific folder (from context menu)
  const handleCreateNoteInFolder = useCallback(
    async (folderPath: string) => {
      if (isCreating) return

      setIsCreating(true)
      try {
        // Get folder's default template (if any)
        const templateId = await notesService.getFolderTemplate(folderPath)

        const result = await createNoteMutateAsync({
          title: 'Untitled',
          folder: folderPath || undefined,
          template: templateId ?? undefined
          // Note: content is intentionally omitted to allow template content to be used
        })

        if (result.success && result.note) {
          const newNote = result.note
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
        log.error('Failed to create note', err)
      } finally {
        setIsCreating(false)
      }
    },
    [isCreating, createNoteMutateAsync, openTab]
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
        log.error('Failed to create folder', err)
      } finally {
        setIsCreatingFolder(false)
      }
    },
    [isCreatingFolder, createFolder, folders, refreshFolders]
  )

  // Context menu action handlers
  const handleRenameClick = useCallback((note: NoteListItem) => {
    const displayName = getDisplayName(note.path)
    originalRenameTitle.current = displayName
    setRenamingNoteId(note.id)
    setRenameValue(displayName)
  }, [])

  const renameCallbackRef = useCallback(
    (el: HTMLInputElement | null) => {
      renameInputRef.current = el
      if (el) {
        el.focus()
        el.select()
      }
    },
    []
  )

  const handleRenameInputChange = useCallback(
    (noteId: string, value: string) => {
      setRenameValue(value)
      const displayTitle = value || 'Untitled'
      updateTabTitleByEntityId(noteId, displayTitle)
      queryClient.setQueryData<Note>(notesKeys.note(noteId), (old) =>
        old ? { ...old, title: displayTitle } : old
      )
    },
    [updateTabTitleByEntityId, queryClient]
  )

  const revertOptimisticTitle = useCallback(
    (noteId: string) => {
      const title = originalRenameTitle.current
      updateTabTitleByEntityId(noteId, title)
      queryClient.setQueryData<Note>(notesKeys.note(noteId), (old) =>
        old ? { ...old, title } : old
      )
    },
    [updateTabTitleByEntityId, queryClient]
  )

  const handleRenameSubmit = useCallback(
    async (noteId: string, originalPath: string) => {
      if (!renameValue.trim() || isRenaming) {
        revertOptimisticTitle(noteId)
        setRenamingNoteId(null)
        return
      }

      const currentName = getDisplayName(originalPath)
      if (renameValue.trim() === currentName) {
        revertOptimisticTitle(noteId)
        setRenamingNoteId(null)
        return
      }

      setIsRenaming(true)
      try {
        await renameNoteMutateAsync({ id: noteId, newTitle: renameValue.trim() })
      } catch (err) {
        log.error('Failed to rename note', err)
        revertOptimisticTitle(noteId)
      } finally {
        setIsRenaming(false)
        setRenamingNoteId(null)
      }
    },
    [renameValue, isRenaming, renameNoteMutateAsync, revertOptimisticTitle]
  )

  const handleRenameCancel = useCallback(
    (noteId?: string) => {
      if (noteId) {
        revertOptimisticTitle(noteId)
      }
      setRenamingNoteId(null)
      setRenameValue('')
    },
    [revertOptimisticTitle]
  )

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
        log.error('Failed to rename folder', err)
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
        const result = await deleteNoteMutateAsync(note.id)
        if (result.success) {
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
      log.error('Failed to delete items', err)
    } finally {
      setIsDeleting(false)
    }
  }, [notesToDelete, foldersToDelete, isDeleting, deleteNoteMutateAsync, closeTab, refreshFolders])

  const handleOpenExternal = useCallback(async (note: NoteListItem) => {
    try {
      await notesService.openExternal(note.id)
    } catch (err) {
      log.error('Failed to open note externally', err)
    }
  }, [])

  const handleRevealInFinder = useCallback(async (note: NoteListItem) => {
    try {
      await notesService.revealInFinder(note.id)
    } catch (err) {
      log.error('Failed to reveal note in Finder', err)
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
        await moveNoteMutateAsync({ id: noteId, newFolder: targetFolder })
        return true
      } catch (err) {
        log.error('Failed to move note', err)
        return false
      }
    },
    [noteMap, moveNoteMutateAsync]
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
          log.warn('Cannot move folder into itself or its descendants')
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
        log.error('Failed to move folder', err)
        return false
      }
    },
    [noteMap, refreshFolders]
  )

  /**
   * Handle reordering notes within the same folder
   */
  const handleReorderInFolder = useCallback(
    async (
      folderPath: string,
      draggedNoteId: string,
      targetNoteId: string,
      position: DropPosition
    ): Promise<boolean> => {
      const folderNotes = getNotesInFolder(tree, folderPath)
      if (folderNotes.length < 2) return false

      const draggedNote = noteMap.get(draggedNoteId)
      const targetNote = noteMap.get(targetNoteId)
      if (!draggedNote || !targetNote) return false

      const currentPaths = folderNotes.map((n) => n.path)
      const draggedIndex = currentPaths.indexOf(draggedNote.path)
      const targetIndex = currentPaths.indexOf(targetNote.path)

      if (draggedIndex === -1 || targetIndex === -1) return false

      const newPaths = [...currentPaths]
      newPaths.splice(draggedIndex, 1)

      let insertIndex = targetIndex
      if (draggedIndex < targetIndex) {
        insertIndex = targetIndex - 1
      }
      if (position === 'after') {
        insertIndex += 1
      }

      newPaths.splice(insertIndex, 0, draggedNote.path)

      if (newPaths.every((p, i) => p === currentPaths[i])) {
        return false
      }

      try {
        await notesService.reorder(folderPath, newPaths)
        const result = await notesService.getAllPositions()
        if (result.success) {
          setNotePositions(result.positions)
        }
        return true
      } catch (err) {
        log.error('Failed to reorder notes', err)
        return false
      }
    },
    [tree, noteMap]
  )

  /**
   * Handle reordering folders within the same parent folder
   */
  const handleReorderFoldersInParent = useCallback(
    async (
      parentPath: string,
      draggedFolderPath: string,
      targetFolderPath: string,
      position: DropPosition
    ): Promise<boolean> => {
      const siblingFolders = getFoldersInParent(tree, parentPath)
      if (siblingFolders.length < 2) return false

      const draggedIndex = siblingFolders.indexOf(draggedFolderPath)
      const targetIndex = siblingFolders.indexOf(targetFolderPath)

      if (draggedIndex === -1 || targetIndex === -1) return false

      const newPaths = [...siblingFolders]
      newPaths.splice(draggedIndex, 1)

      let insertIndex = targetIndex
      if (draggedIndex < targetIndex) {
        insertIndex = targetIndex - 1
      }
      if (position === 'after') {
        insertIndex += 1
      }

      newPaths.splice(insertIndex, 0, draggedFolderPath)

      if (newPaths.every((p, i) => p === siblingFolders[i])) {
        return false
      }

      try {
        // Reorder folders using the same reorder API (positions work for both)
        await notesService.reorder(parentPath, newPaths)
        const result = await notesService.getAllPositions()
        if (result.success) {
          setNotePositions(result.positions)
        }
        return true
      } catch (err) {
        log.error('Failed to reorder folders', err)
        return false
      }
    },
    [tree]
  )

  /**
   * Main move handler called when drag-drop completes
   * Supports multi-selection: all selected items are moved together
   */
  const handleMove = useCallback(
    async (operation: MoveOperation) => {
      if (isMoving) return

      const { draggedId, targetId, position } = operation

      if (draggedId === targetId) return

      setIsMoving(true)

      try {
        const isPartOfSelection = selectedIds.includes(draggedId)
        const itemsToMove =
          isPartOfSelection && selectedIds.length > 1
            ? selectedIds.filter((id) => id !== targetId)
            : [draggedId]

        const notesToMove: string[] = []
        const foldersToMove: string[] = []

        for (const id of itemsToMove) {
          if (id.startsWith('folder-')) {
            foldersToMove.push(id.replace('folder-', ''))
          } else {
            notesToMove.push(id)
          }
        }

        const targetFolder = calculateTargetFolder(targetId, position)

        // Check for folder reordering (single folder dragged before/after another folder)
        if (
          foldersToMove.length === 1 &&
          notesToMove.length === 0 &&
          targetId.startsWith('folder-') &&
          (position === 'before' || position === 'after')
        ) {
          const draggedFolderPath = foldersToMove[0]
          const targetFolderPath = targetId.replace('folder-', '')

          // Get parent paths to check if they're siblings
          const draggedParent = getParentFolder(draggedFolderPath)
          const targetParent = getParentFolder(targetFolderPath)

          if (draggedParent === targetParent) {
            // Same parent - this is a reorder operation
            const reordered = await handleReorderFoldersInParent(
              draggedParent,
              draggedFolderPath,
              targetFolderPath,
              position
            )
            if (reordered) {
              return
            }
          }
        }

        // Handle folder moves (different parent or inside drop)
        for (const folderPath of foldersToMove) {
          await handleFolderMove(folderPath, targetId, position)
        }

        // Check for note reordering (single note dragged before/after another note)
        if (
          notesToMove.length === 1 &&
          foldersToMove.length === 0 &&
          !targetId.startsWith('folder-') &&
          targetId !== 'notes-root' &&
          (position === 'before' || position === 'after')
        ) {
          const draggedNote = noteMap.get(notesToMove[0])
          const targetNote = noteMap.get(targetId)

          if (draggedNote && targetNote) {
            const draggedFolder = extractFolderFromPath(draggedNote.path)
            const dropFolder = extractFolderFromPath(targetNote.path)

            if (draggedFolder === dropFolder) {
              const reordered = await handleReorderInFolder(
                draggedFolder,
                notesToMove[0],
                targetId,
                position
              )
              if (reordered) {
                return
              }
            }
          }
        }

        for (const noteId of notesToMove) {
          await handleNoteMove(noteId, targetFolder)
        }

        if (itemsToMove.length > 1) {
          setSelectedIds([])
        }
      } finally {
        setIsMoving(false)
      }
    },
    [
      isMoving,
      selectedIds,
      calculateTargetFolder,
      handleNoteMove,
      handleFolderMove,
      handleReorderInFolder,
      handleReorderFoldersInParent,
      noteMap
    ]
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
        {/* Import Files button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleImportFiles}>
              <Import className="h-3.5 w-3.5" />
              <span className="sr-only">Import Files</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Import files{targetFolder ? ` to ${targetFolder}` : ''}</p>
          </TooltipContent>
        </Tooltip>
      </>
    ),
    [
      handleCreateNote,
      handleCreateFolder,
      handleImportFiles,
      isCreating,
      isCreatingFolder,
      targetFolder
    ]
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
    return <NotesTreeError error={extractErrorMessage(error, 'Failed to load notes')} />
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
          <TreeIcon icon={getFileIcon(note)} />
          {isBeingRenamed ? (
            <input
              ref={renameCallbackRef}
              type="text"
              value={renameValue}
              onChange={(e) => handleRenameInputChange(note.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleRenameSubmit(note.id, note.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  handleRenameCancel(note.id)
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
      <TreeNode key={folder.path} nodeId={`folder-${folder.path}`} level={level} isLast={isLast} acceptsDropInside>
        <TreeNodeTrigger
          expandOnly
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
    <div
      ref={treeContainerRef}
      className="flex flex-col"
      tabIndex={-1}
      onFocus={() => {
        isTreeFocusedRef.current = true
        setIsTreeFocused(true)
      }}
      onBlur={(e) => {
        if (!treeContainerRef.current?.contains(e.relatedTarget as Node)) {
          isTreeFocusedRef.current = false
          setIsTreeFocused(false)
        }
      }}
    >
      <TreeProvider
        selectedIds={selectedIds}
        onSelectionChange={handleSelectionChange}
        draggable={!renamingNoteId && !renamingFolderPath && !isMoving}
        onMove={handleMove}
        animateExpand={false}
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
