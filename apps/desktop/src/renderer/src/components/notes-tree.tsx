'use client'

/**
 * NotesTree Component
 *
 * Displays real notes from the vault in a tree structure.
 * Replaces the hardcoded FileTree with data from useNotes() hook.
 */

import { useMemo, useCallback, useState, useRef, useEffect, type ReactNode } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { SIDEBAR_REVEAL_FOLDER_EVENT } from '@/components/note/note-breadcrumb'
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
  type MoveOperation
} from '@/components/kibo-ui/tree'
import { useQueryClient } from '@tanstack/react-query'
import { useTabActions } from '@/contexts/tabs'
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
  LayoutTemplate,
  LayoutGrid,
  X,
  FileType2,
  Image,
  Music,
  Video,
  Monitor,
  Smile
} from '@/lib/icons'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
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
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { FolderIconButton } from '@/components/folder-icon-button'
import { getTabIconForFileType, type FileType } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import {
  type FolderNode,
  type TreeStructure,
  getDisplayName,
  buildTreeFromNotes
} from './notes-tree-utils'
import { useTreeDragDrop } from './hooks/use-tree-drag-drop'
import { useTreeRename } from './hooks/use-tree-rename'
import { useTreeDelete } from './hooks/use-tree-delete'

const log = createLogger('Component:NotesTree')

/**
 * Wrapper that reads tree expand state and passes it to FolderIconButton.
 * Must be rendered inside TreeProvider.
 */
function TreeFolderIcon({
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

/**
 * Get the appropriate icon component for a file based on its type.
 * Returns the icon element to render in the tree.
 */
function getFileIcon(note: NoteListItem): React.ReactElement {
  // Emoji/icon takes priority for markdown files
  if (note.emoji) {
    return <NoteIconDisplay value={note.emoji} className="text-sm leading-none" />
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
      return <Video className={iconClass} />
    case 'markdown':
    default:
      return <FileText className={iconClass} />
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
// RevealHandler — must render inside TreeProvider to access useTree()
// ============================================================================

interface RevealHandlerProps {
  pendingRevealNoteId: string | null
  noteMap: Map<string, { path: string }>
  onReveal: (noteId: string) => void
  onClear: () => void
}

function RevealHandler({ pendingRevealNoteId, noteMap, onReveal, onClear }: RevealHandlerProps) {
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

function FolderRevealHandler() {
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
// TreeActionsExposer — bridges tree context methods to parent via ref
// ============================================================================

type TreeActionsHandle = {
  collapseAll: () => void
  expandAll: () => void
  expandNode: (nodeId: string) => void
  expandNodes: (nodeIds: string[]) => void
}

function TreeActionsExposer({
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
  const { folders, createFolder, setFolderIcon, refetch: refreshFolders } = useNoteFoldersQuery()
  const { openTab, closeTab, updateTabTitleByEntityId } = useTabActions()
  const queryClient = useQueryClient()
  const { settings: generalSettings } = useGeneralSettings()
  const [isCreating, setIsCreating] = useState(false)
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const treeActionsRef = useRef<TreeActionsHandle | null>(null)

  // Multi-selection state (controlled mode)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const treeContainerRef = useRef<HTMLDivElement>(null)
  const [isTreeFocused, setIsTreeFocused] = useState(false)
  const isTreeFocusedRef = useRef(false)

  // Folder icon picker state
  const [iconPickerFolderPath, setIconPickerFolderPath] = useState<string | null>(null)

  // Folder template configuration state
  const [folderToConfigureTemplate, setFolderToConfigureTemplate] = useState<string | null>(null)
  const [folderTemplateNames, setFolderTemplateNames] = useState<Map<string, string>>(new Map())

  // Note positions for custom ordering
  const [notePositions, setNotePositions] = useState<Record<string, number>>({})

  // Focus handled by renameCallbackRef / folderRenameCallbackRef (synchronous on mount)

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
          folders.map(async (f) => {
            try {
              const config = await notesService.getFolderConfig(f.path)
              if (config?.template) {
                const templateName = templatesMap.get(config.template)
                if (templateName) {
                  namesMap.set(f.path, templateName)
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

  // Extracted hooks for drag-drop, rename, and delete
  const { isMoving, handleMove } = useTreeDragDrop({
    tree,
    noteMap,
    selectedIds,
    setSelectedIds,
    setNotePositions,
    moveNoteMutateAsync,
    refreshFolders
  })

  const rename = useTreeRename({
    renameNoteMutateAsync,
    updateTabTitleByEntityId,
    queryClient,
    refreshFolders
  })

  const del = useTreeDelete({
    selectedIds,
    setSelectedIds,
    noteMap,
    deleteNoteMutateAsync,
    closeTab,
    refreshFolders
  })

  // Compute target folder from selection — only when tree is focused so toolbar
  // buttons create at root when the user clicks away from the tree
  const targetFolder = useMemo(() => {
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

    const folder = generalSettings.createInSelectedFolder ? targetFolder : ''

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

        rename.originalRenameTitle.current = 'Untitled'
        rename.setRenamingNoteId(newNote.id)
        rename.setRenameValue('Untitled')
      }
    } catch (err) {
      log.error('Failed to create note', err)
      toast.error(extractErrorMessage(err, 'Failed to create note'))
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

    const folder = generalSettings.createInSelectedFolder ? targetFolder : ''

    setIsCreatingFolder(true)
    try {
      const baseName = 'Untitled Folder'
      let folderName = baseName
      let counter = 1
      const targetPath = folder ? `${folder}/` : ''

      while (folders.some((f) => f.path === `${targetPath}${folderName}`)) {
        folderName = `${baseName} ${counter++}`
      }

      const fullPath = `${targetPath}${folderName}`
      const success = await createFolder(fullPath)

      if (success) {
        await refreshFolders()
        rename.setRenamingFolderPath(fullPath)
        rename.setFolderRenameValue(folderName)
      }
    } catch (err) {
      log.error('Failed to create folder', err)
      toast.error(extractErrorMessage(err, 'Failed to create folder'))
    } finally {
      setIsCreatingFolder(false)
    }
  }, [isCreatingFolder, createFolder, folders, targetFolder, refreshFolders])

  useEffect(() => {
    onTargetFolderChange?.(targetFolder)
  }, [targetFolder, onTargetFolderChange])

  useEffect(() => {
    onActionsReady?.({
      createNote: handleCreateNote,
      createFolder: handleCreateFolder,
      collapseAll: () => treeActionsRef.current?.collapseAll(),
      expandAll: () => treeActionsRef.current?.expandAll()
    })
  }, [onActionsReady, handleCreateNote, handleCreateFolder])

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
        toast.error(extractErrorMessage(err, 'Failed to create note'))
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

        while (folders.some((f) => f.path === `${targetPath}${folderName}`)) {
          folderName = `${baseName} ${counter++}`
        }

        const fullPath = `${targetPath}${folderName}`
        const success = await createFolder(fullPath)

        if (success) {
          await refreshFolders()
        }
      } catch (err) {
        log.error('Failed to create folder', err)
        toast.error(extractErrorMessage(err, 'Failed to create folder'))
      } finally {
        setIsCreatingFolder(false)
      }
    },
    [isCreatingFolder, createFolder, folders, refreshFolders]
  )

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

  // Handle Delete key to delete selected notes
  useEffect(() => {
    const container = treeContainerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (rename.renamingNoteId) return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        const activeElement = document.activeElement
        if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA') {
          return
        }

        e.preventDefault()
        del.handleBulkDelete()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds, rename.renamingNoteId, del.handleBulkDelete])

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

  const handleRevealComplete = useCallback(
    (noteId: string) => {
      setSelectedIds([noteId])
      setTimeout(() => {
        const element = document.querySelector(`[data-tree-node-id="${noteId}"]`)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          element.classList.add('bg-accent')
          setTimeout(() => {
            element.classList.remove('bg-accent')
          }, 2000)
        }
      }, 100)
      setPendingRevealNoteId(null)
    },
    [setSelectedIds]
  )

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
  const renderNote = (note: NoteListItem, level: number, isLast: boolean, hideLines = false) => {
    const isBeingRenamed = rename.renamingNoteId === note.id
    const isSelected = selectedIds.includes(note.id)
    const hasMultipleSelected = selectedIds.length > 1
    const isPartOfSelection = isSelected && hasMultipleSelected

    return (
      <TreeNode key={note.id} nodeId={note.id} level={level} isLast={isLast} hideLines={hideLines}>
        <TreeNodeTrigger
          contextMenuContent={
            <>
              {/* Single item actions - only show when not part of multi-select */}
              {!isPartOfSelection && (
                <>
                  <ContextMenuItem onClick={() => rename.handleRenameClick(note)}>
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
                    onClick={() => del.handleDeleteClick(note)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </>
              )}
              {/* Bulk actions - show when part of multi-select */}
              {isPartOfSelection && (
                <ContextMenuItem variant="destructive" onClick={del.handleBulkDelete}>
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
              ref={rename.renameCallbackRef}
              type="text"
              value={rename.renameValue}
              onChange={(e) => rename.handleRenameInputChange(note.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  rename.handleRenameSubmit(note.id, note.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  rename.handleRenameCancel(note.id)
                }
                e.stopPropagation()
              }}
              onBlur={() => rename.handleRenameSubmit(note.id, note.path)}
              onClick={(e) => e.stopPropagation()}
              disabled={rename.isRenaming}
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

  // Render folder with its contents
  const renderFolder = (folder: FolderNode, level: number, isLast: boolean): ReactNode => {
    const hasChildren = folder.children.length > 0 || folder.notes.length > 0
    const isBeingRenamed = rename.renamingFolderPath === folder.path

    return (
      <TreeNode
        key={folder.path}
        nodeId={`folder-${folder.path}`}
        level={level}
        isLast={isLast}
        acceptsDropInside
      >
        <TreeNodeTrigger
          expandOnly
          className="group/folderrow"
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
              <ContextMenuItem onClick={() => setIconPickerFolderPath(folder.path)}>
                <Smile className="mr-2 h-4 w-4" />
                Set Icon
              </ContextMenuItem>
              {folder.icon && (
                <ContextMenuItem onClick={() => void setFolderIcon(folder.path, null)}>
                  <X className="mr-2 h-4 w-4" />
                  Remove Icon
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => rename.handleRenameFolderClick(folder.path)}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => del.handleDeleteFolderClick(folder.path)}
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
            onIconChange={(icon) => void setFolderIcon(folder.path, icon)}
            pickerOpen={iconPickerFolderPath === folder.path}
            onPickerOpenChange={(open) => setIconPickerFolderPath(open ? folder.path : null)}
          />
          {isBeingRenamed ? (
            <input
              ref={rename.folderRenameCallbackRef}
              type="text"
              value={rename.folderRenameValue}
              onChange={(e) => rename.setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  rename.handleFolderRenameSubmit(folder.path)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  rename.handleFolderRenameCancel()
                }
                e.stopPropagation()
              }}
              onBlur={() => rename.handleFolderRenameSubmit(folder.path)}
              onClick={(e) => e.stopPropagation()}
              disabled={rename.isFolderRenaming}
              className="flex-1 h-5 px-1 text-sm bg-background border border-input rounded focus:outline-none"
            />
          ) : (
            <div className="group/folder flex flex-1 items-center min-w-0">
              <TreeLabel className="flex-1">{folder.name}</TreeLabel>
              {/* Hover action icon to open folder view */}
              <div className="flex items-center opacity-0 group-hover/folder:opacity-100 transition-opacity ml-auto">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleOpenFolderView(folder.path)
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
        draggable={!rename.renamingNoteId && !rename.renamingFolderPath && !isMoving}
        onMove={handleMove}
        animateExpand={false}
        multiSelect={true}
        indent={26}
      >
        <TreeActionsExposer actionsRef={treeActionsRef} />
        {/* Handle reveal-in-sidebar requests */}
        <RevealHandler
          pendingRevealNoteId={pendingRevealNoteId}
          noteMap={noteMap}
          onReveal={handleRevealComplete}
          onClear={() => setPendingRevealNoteId(null)}
        />
        <FolderRevealHandler />
        <TreeView>
          {/* Folders first */}
          {tree.folders.map((folder, index) =>
            renderFolder(
              folder,
              0,
              index === tree.folders.length - 1 && tree.rootNotes.length === 0
            )
          )}

          {/* Root notes — indented to align with folder children, no indent lines */}
          {tree.rootNotes.map((note, index) =>
            renderNote(note, 1, index === tree.rootNotes.length - 1, true)
          )}
        </TreeView>
      </TreeProvider>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={del.isDeleteDialogOpen} onOpenChange={del.setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {(() => {
                const totalItems = del.notesToDelete.length + del.foldersToDelete.length
                if (totalItems === 1) {
                  if (del.foldersToDelete.length === 1) return 'Delete Folder'
                  return 'Delete Note'
                }
                return `Delete ${totalItems} Items`
              })()}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                {(() => {
                  const totalItems = del.notesToDelete.length + del.foldersToDelete.length

                  // Single item
                  if (totalItems === 1) {
                    if (del.foldersToDelete.length === 1) {
                      const folderName =
                        del.foldersToDelete[0].split('/').pop() || del.foldersToDelete[0]
                      return (
                        <>
                          Are you sure you want to delete the folder &quot;{folderName}&quot; and
                          all its contents? This action cannot be undone.
                        </>
                      )
                    }
                    return (
                      <>
                        Are you sure you want to delete &quot;
                        {getDisplayName(del.notesToDelete[0]?.path || '')}&quot;? This action cannot
                        be undone.
                      </>
                    )
                  }

                  // Multiple items
                  return (
                    <>
                      Are you sure you want to delete these items? This action cannot be undone.
                      <ul className="mt-2 max-h-32 overflow-y-auto text-sm list-disc list-inside">
                        {del.foldersToDelete.slice(0, 3).map((folderPath) => (
                          <li key={`folder-${folderPath}`} className="flex items-center gap-1">
                            <Folder className="h-3 w-3 inline" />
                            {folderPath.split('/').pop() || folderPath} (folder)
                          </li>
                        ))}
                        {del.notesToDelete
                          .slice(0, 5 - Math.min(del.foldersToDelete.length, 3))
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
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={del.handleDeleteConfirm}
              disabled={del.isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {del.isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : del.notesToDelete.length + del.foldersToDelete.length === 1 ? (
                'Delete'
              ) : (
                `Delete ${del.notesToDelete.length + del.foldersToDelete.length}`
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
