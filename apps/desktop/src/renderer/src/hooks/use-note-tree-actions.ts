import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useTabActions } from '@/contexts/tabs'
import { notesKeys, useNoteMutations } from '@/hooks/use-notes-query'
import type { Note } from '@memry/contracts/notes-api'
import type { NoteListItem } from '@/hooks/use-notes-query'
import type { FolderInfo } from '../../../preload/index.d'
import { notesService } from '@/services/notes-service'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { getTabIconForFileType, type FileType } from '@memry/shared/file-types'
import {
  getDisplayName,
  extractFolderFromPath,
  getParentFolder,
  isDescendantOrSelf,
  getNotesInFolder,
  getFoldersInParent,
  type TreeStructure
} from '@/components/notes-tree-utils'
import type { MoveOperation, DropPosition } from '@/components/kibo-ui/tree'

const log = createLogger('Hook:NoteTreeActions')

type NoteMutations = ReturnType<typeof useNoteMutations>

export interface NoteTreeActionsDeps {
  noteMap: Map<string, NoteListItem>
  tree: TreeStructure
  folders: FolderInfo[]
  notePositions: Record<string, number>
  setNotePositions: React.Dispatch<React.SetStateAction<Record<string, number>>>
  folderTemplateNames: Map<string, string>
  setFolderTemplateNames: React.Dispatch<React.SetStateAction<Map<string, string>>>
  createFolderMutation: (path: string) => Promise<boolean>
  refreshFolders: () => Promise<unknown>
  setFolderIcon: (path: string, icon: string | null) => Promise<boolean>
  mutations: NoteMutations
  selectedIds: string[]
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>
  computeTargetFolder: (selectedIds: string[]) => string
  expandFolderPath: (path: string) => void
}

export function useNoteTreeActions(deps: NoteTreeActionsDeps) {
  const { settings: generalSettings } = useGeneralSettings()
  const { openTab, closeTab, updateTabTitleByEntityId } = useTabActions()
  const queryClient = useQueryClient()
  const originalRenameTitle = useRef<string>('')

  const [isCreating, setIsCreating] = useState(false)
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [isMoving, setIsMoving] = useState(false)

  // Delete dialog state
  const [notesToDelete, setNotesToDelete] = useState<NoteListItem[]>([])
  const [foldersToDelete, setFoldersToDelete] = useState<string[]>([])
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Inline rename state for notes
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

  // Folder rename state
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [isFolderRenaming, setIsFolderRenaming] = useState(false)

  // Folder template config state
  const [folderToConfigureTemplate, setFolderToConfigureTemplate] = useState<string | null>(null)

  // Folder icon picker state
  const [iconPickerFolderPath, setIconPickerFolderPath] = useState<string | null>(null)

  // ---- Selection handling ----

  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      deps.setSelectedIds(ids)

      const noteIds = ids.filter((id) => !id.startsWith('folder-') && id !== 'notes-root')
      if (noteIds.length === 1) {
        const note = deps.noteMap.get(noteIds[0])
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
            isPreview: false,
            isDeleted: false
          })
        }
      }
    },
    [deps.noteMap, deps.setSelectedIds, openTab]
  )

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
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  // ---- Create note ----

  const handleCreateNote = useCallback(async () => {
    if (isCreating) return

    const folder = generalSettings.createInSelectedFolder
      ? deps.computeTargetFolder(deps.selectedIds)
      : ''
    deps.expandFolderPath(folder)

    setIsCreating(true)
    try {
      const templateId = folder ? await notesService.getFolderTemplate(folder) : null

      const result = await deps.mutations.createNote.mutateAsync({
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
      toast.error(extractErrorMessage(err, 'Failed to create note'))
    } finally {
      setIsCreating(false)
    }
  }, [
    isCreating,
    deps.mutations.createNote.mutateAsync,
    deps.selectedIds,
    deps.computeTargetFolder,
    deps.expandFolderPath,
    openTab,
    generalSettings.createInSelectedFolder
  ])

  const handleCreateNoteInFolder = useCallback(
    async (folderPath: string) => {
      if (isCreating) return

      setIsCreating(true)
      try {
        const templateId = await notesService.getFolderTemplate(folderPath)

        const result = await deps.mutations.createNote.mutateAsync({
          title: 'Untitled',
          folder: folderPath || undefined,
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
        }
      } catch (err) {
        log.error('Failed to create note', err)
        toast.error(extractErrorMessage(err, 'Failed to create note'))
      } finally {
        setIsCreating(false)
      }
    },
    [isCreating, deps.mutations.createNote.mutateAsync, openTab]
  )

  // ---- Create folder ----

  const handleCreateFolder = useCallback(async () => {
    if (isCreatingFolder) return

    const folder = generalSettings.createInSelectedFolder
      ? deps.computeTargetFolder(deps.selectedIds)
      : ''
    deps.expandFolderPath(folder)

    setIsCreatingFolder(true)
    try {
      const baseName = 'Untitled Folder'
      let folderName = baseName
      let counter = 1
      const targetPath = folder ? `${folder}/` : ''

      while (deps.folders.some((f) => f.path === `${targetPath}${folderName}`)) {
        folderName = `${baseName} ${counter++}`
      }

      const fullPath = `${targetPath}${folderName}`
      const success = await deps.createFolderMutation(fullPath)

      if (success) {
        await deps.refreshFolders()
        setRenamingFolderPath(fullPath)
        setFolderRenameValue(folderName)
      }
    } catch (err) {
      log.error('Failed to create folder', err)
      toast.error(extractErrorMessage(err, 'Failed to create folder'))
    } finally {
      setIsCreatingFolder(false)
    }
  }, [
    isCreatingFolder,
    deps.createFolderMutation,
    deps.folders,
    deps.selectedIds,
    deps.computeTargetFolder,
    deps.expandFolderPath,
    deps.refreshFolders,
    generalSettings.createInSelectedFolder
  ])

  const handleCreateSubfolder = useCallback(
    async (parentPath: string) => {
      if (isCreatingFolder) return

      setIsCreatingFolder(true)
      try {
        const baseName = 'Untitled Folder'
        let folderName = baseName
        let counter = 1
        const targetPath = parentPath ? `${parentPath}/` : ''

        while (deps.folders.some((f) => f.path === `${targetPath}${folderName}`)) {
          folderName = `${baseName} ${counter++}`
        }

        const fullPath = `${targetPath}${folderName}`
        const success = await deps.createFolderMutation(fullPath)

        if (success) {
          await deps.refreshFolders()
        }
      } catch (err) {
        log.error('Failed to create folder', err)
        toast.error(extractErrorMessage(err, 'Failed to create folder'))
      } finally {
        setIsCreatingFolder(false)
      }
    },
    [isCreatingFolder, deps.createFolderMutation, deps.folders, deps.refreshFolders]
  )

  // ---- Note rename ----

  const handleRenameClick = useCallback((note: NoteListItem) => {
    const displayName = getDisplayName(note.path)
    originalRenameTitle.current = displayName
    setRenamingNoteId(note.id)
    setRenameValue(displayName)
  }, [])

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
        await deps.mutations.renameNote.mutateAsync({ id: noteId, newTitle: renameValue.trim() })
      } catch (err) {
        log.error('Failed to rename note', err)
        revertOptimisticTitle(noteId)
        toast.error(extractErrorMessage(err, 'Failed to rename note'))
      } finally {
        setIsRenaming(false)
        setRenamingNoteId(null)
      }
    },
    [renameValue, isRenaming, deps.mutations.renameNote.mutateAsync, revertOptimisticTitle]
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

  // ---- Folder rename ----

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
        const parentPath = oldPath.includes('/')
          ? oldPath.substring(0, oldPath.lastIndexOf('/'))
          : ''
        const newPath = parentPath
          ? `${parentPath}/${folderRenameValue.trim()}`
          : folderRenameValue.trim()

        await notesService.renameFolder(oldPath, newPath)
        await deps.refreshFolders()
      } catch (err) {
        log.error('Failed to rename folder', err)
        toast.error(extractErrorMessage(err, 'Failed to rename folder'))
      } finally {
        setIsFolderRenaming(false)
        setRenamingFolderPath(null)
      }
    },
    [folderRenameValue, isFolderRenaming, deps.refreshFolders]
  )

  const handleFolderRenameCancel = useCallback(() => {
    setRenamingFolderPath(null)
    setFolderRenameValue('')
  }, [])

  // ---- Delete ----

  const handleDeleteClick = useCallback((note: NoteListItem) => {
    setNotesToDelete([note])
    setFoldersToDelete([])
    setIsDeleteDialogOpen(true)
  }, [])

  const handleDeleteFolderClick = useCallback((folderPath: string) => {
    setNotesToDelete([])
    setFoldersToDelete([folderPath])
    setIsDeleteDialogOpen(true)
  }, [])

  const handleBulkDelete = useCallback(() => {
    const folderPaths: string[] = []
    const selectedNotes: NoteListItem[] = []

    for (const id of deps.selectedIds) {
      if (id.startsWith('folder-')) {
        folderPaths.push(id.replace('folder-', ''))
      } else {
        const note = deps.noteMap.get(id)
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
  }, [deps.selectedIds, deps.noteMap])

  const handleDeleteConfirm = useCallback(async () => {
    if ((notesToDelete.length === 0 && foldersToDelete.length === 0) || isDeleting) return

    setIsDeleting(true)
    try {
      for (const note of notesToDelete) {
        const result = await deps.mutations.deleteNote.mutateAsync(note.id)
        if (result.success) {
          closeTab(`/notes/${note.id}`)
        }
      }

      for (const folderPath of foldersToDelete) {
        await notesService.deleteFolder(folderPath)
      }

      if (foldersToDelete.length > 0) {
        await deps.refreshFolders()
      }

      setIsDeleteDialogOpen(false)
      setNotesToDelete([])
      setFoldersToDelete([])
      deps.setSelectedIds([])
    } catch (err) {
      log.error('Failed to delete items', err)
    } finally {
      setIsDeleting(false)
    }
  }, [
    notesToDelete,
    foldersToDelete,
    isDeleting,
    deps.mutations.deleteNote.mutateAsync,
    closeTab,
    deps.refreshFolders,
    deps.setSelectedIds
  ])

  // ---- External / Finder ----

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

  // ---- Folder templates ----

  const handleSetFolderTemplate = useCallback((folderPath: string) => {
    setFolderToConfigureTemplate(folderPath)
  }, [])

  const handleFolderTemplateSelect = useCallback(
    async (templateId: string | null) => {
      if (folderToConfigureTemplate && templateId) {
        try {
          await notesService.setFolderConfig(folderToConfigureTemplate, {
            template: templateId,
            inherit: true
          })
          const templatesResponse = await window.api.templates.list()
          const template = templatesResponse.templates.find((t) => t.id === templateId)
          if (template) {
            deps.setFolderTemplateNames((prev) => {
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
    [folderToConfigureTemplate, deps.setFolderTemplateNames]
  )

  const handleClearFolderTemplate = useCallback(
    async (folderPath: string) => {
      try {
        await notesService.setFolderConfig(folderPath, {
          template: undefined,
          inherit: true
        })
        deps.setFolderTemplateNames((prev) => {
          const next = new Map(prev)
          next.delete(folderPath)
          return next
        })
        toast.success('Default template cleared')
      } catch (err) {
        log.error('Failed to clear folder template', err)
        toast.error('Failed to clear default template')
      }
    },
    [deps.setFolderTemplateNames]
  )

  // ---- Move / Reorder ----

  const calculateTargetFolder = useCallback(
    (targetId: string, position: DropPosition): string => {
      if (targetId === 'notes-root' || targetId === '') return ''

      if (targetId.startsWith('folder-')) {
        const folderPath = targetId.replace('folder-', '')
        if (position === 'inside') return folderPath
        return getParentFolder(folderPath)
      }

      const targetNote = deps.noteMap.get(targetId)
      if (targetNote) return extractFolderFromPath(targetNote.path)

      return ''
    },
    [deps.noteMap]
  )

  const handleNoteMove = useCallback(
    async (noteId: string, targetFolder: string): Promise<boolean> => {
      const note = deps.noteMap.get(noteId)
      if (!note) return false

      const currentFolder = extractFolderFromPath(note.path)
      if (currentFolder === targetFolder) return false

      try {
        await deps.mutations.moveNote.mutateAsync({ id: noteId, newFolder: targetFolder })
        return true
      } catch (err) {
        log.error('Failed to move note', err)
        return false
      }
    },
    [deps.noteMap, deps.mutations.moveNote.mutateAsync]
  )

  const handleFolderMove = useCallback(
    async (
      sourceFolderPath: string,
      targetId: string,
      position: DropPosition
    ): Promise<boolean> => {
      const sourceFolderName = sourceFolderPath.split('/').pop() || sourceFolderPath

      let newPath = ''

      if (targetId === 'notes-root' || targetId === '') {
        newPath = sourceFolderName
      } else if (targetId.startsWith('folder-')) {
        const targetPath = targetId.replace('folder-', '')

        if (isDescendantOrSelf(sourceFolderPath, targetPath)) {
          log.warn('Cannot move folder into itself or its descendants')
          return false
        }

        if (position === 'inside') {
          newPath = `${targetPath}/${sourceFolderName}`
        } else {
          const parentFolder = getParentFolder(targetPath)
          newPath = parentFolder ? `${parentFolder}/${sourceFolderName}` : sourceFolderName
        }
      } else {
        const targetNote = deps.noteMap.get(targetId)
        if (targetNote) {
          const targetFolder = extractFolderFromPath(targetNote.path)
          newPath = targetFolder ? `${targetFolder}/${sourceFolderName}` : sourceFolderName
        } else {
          newPath = sourceFolderName
        }
      }

      if (newPath === sourceFolderPath) return false

      try {
        await notesService.renameFolder(sourceFolderPath, newPath)
        await deps.refreshFolders()
        return true
      } catch (err) {
        log.error('Failed to move folder', err)
        return false
      }
    },
    [deps.noteMap, deps.refreshFolders]
  )

  const handleReorderInFolder = useCallback(
    async (
      folderPath: string,
      draggedNoteId: string,
      targetNoteId: string,
      position: DropPosition
    ): Promise<boolean> => {
      const folderNotes = getNotesInFolder(deps.tree, folderPath)
      if (folderNotes.length < 2) return false

      const draggedNote = deps.noteMap.get(draggedNoteId)
      const targetNote = deps.noteMap.get(targetNoteId)
      if (!draggedNote || !targetNote) return false

      const currentPaths = folderNotes.map((n) => n.path)
      const draggedIndex = currentPaths.indexOf(draggedNote.path)
      const targetIndex = currentPaths.indexOf(targetNote.path)

      if (draggedIndex === -1 || targetIndex === -1) return false

      const newPaths = [...currentPaths]
      newPaths.splice(draggedIndex, 1)

      let insertIndex = targetIndex
      if (draggedIndex < targetIndex) insertIndex = targetIndex - 1
      if (position === 'after') insertIndex += 1

      newPaths.splice(insertIndex, 0, draggedNote.path)

      if (newPaths.every((p, i) => p === currentPaths[i])) return false

      try {
        await notesService.reorder(folderPath, newPaths)
        const result = await notesService.getAllPositions()
        if (result.success) {
          deps.setNotePositions(result.positions)
        }
        return true
      } catch (err) {
        log.error('Failed to reorder notes', err)
        return false
      }
    },
    [deps.tree, deps.noteMap, deps.setNotePositions]
  )

  const handleReorderFoldersInParent = useCallback(
    async (
      parentPath: string,
      draggedFolderPath: string,
      targetFolderPath: string,
      position: DropPosition
    ): Promise<boolean> => {
      const siblingFolders = getFoldersInParent(deps.tree, parentPath)
      if (siblingFolders.length < 2) return false

      const draggedIndex = siblingFolders.indexOf(draggedFolderPath)
      const targetIndex = siblingFolders.indexOf(targetFolderPath)

      if (draggedIndex === -1 || targetIndex === -1) return false

      const newPaths = [...siblingFolders]
      newPaths.splice(draggedIndex, 1)

      let insertIndex = targetIndex
      if (draggedIndex < targetIndex) insertIndex = targetIndex - 1
      if (position === 'after') insertIndex += 1

      newPaths.splice(insertIndex, 0, draggedFolderPath)

      if (newPaths.every((p, i) => p === siblingFolders[i])) return false

      try {
        await notesService.reorder(parentPath, newPaths)
        const result = await notesService.getAllPositions()
        if (result.success) {
          deps.setNotePositions(result.positions)
        }
        return true
      } catch (err) {
        log.error('Failed to reorder folders', err)
        return false
      }
    },
    [deps.tree, deps.setNotePositions]
  )

  const handleMove = useCallback(
    async (operation: MoveOperation) => {
      if (isMoving) return

      const { draggedId, targetId, position } = operation

      if (draggedId === targetId) return

      setIsMoving(true)

      try {
        const isPartOfSelection = deps.selectedIds.includes(draggedId)
        const itemsToMove =
          isPartOfSelection && deps.selectedIds.length > 1
            ? deps.selectedIds.filter((id) => id !== targetId)
            : [draggedId]

        const notesToMove: string[] = []
        const foldersToMoveList: string[] = []

        for (const id of itemsToMove) {
          if (id.startsWith('folder-')) {
            foldersToMoveList.push(id.replace('folder-', ''))
          } else {
            notesToMove.push(id)
          }
        }

        const targetFolderPath = calculateTargetFolder(targetId, position)

        if (
          foldersToMoveList.length === 1 &&
          notesToMove.length === 0 &&
          targetId.startsWith('folder-') &&
          (position === 'before' || position === 'after')
        ) {
          const draggedFolderPath = foldersToMoveList[0]
          const targetFolderPathFromId = targetId.replace('folder-', '')

          const draggedParent = getParentFolder(draggedFolderPath)
          const targetParent = getParentFolder(targetFolderPathFromId)

          if (draggedParent === targetParent) {
            const reordered = await handleReorderFoldersInParent(
              draggedParent,
              draggedFolderPath,
              targetFolderPathFromId,
              position
            )
            if (reordered) return
          }
        }

        for (const folderPath of foldersToMoveList) {
          await handleFolderMove(folderPath, targetId, position)
        }

        if (
          notesToMove.length === 1 &&
          foldersToMoveList.length === 0 &&
          !targetId.startsWith('folder-') &&
          targetId !== 'notes-root' &&
          (position === 'before' || position === 'after')
        ) {
          const draggedNote = deps.noteMap.get(notesToMove[0])
          const targetNoteObj = deps.noteMap.get(targetId)

          if (draggedNote && targetNoteObj) {
            const draggedFolder = extractFolderFromPath(draggedNote.path)
            const dropFolder = extractFolderFromPath(targetNoteObj.path)

            if (draggedFolder === dropFolder) {
              const reordered = await handleReorderInFolder(
                draggedFolder,
                notesToMove[0],
                targetId,
                position
              )
              if (reordered) return
            }
          }
        }

        for (const noteId of notesToMove) {
          await handleNoteMove(noteId, targetFolderPath)
        }

        if (itemsToMove.length > 1) {
          deps.setSelectedIds([])
        }
      } finally {
        setIsMoving(false)
      }
    },
    [
      isMoving,
      deps.selectedIds,
      deps.noteMap,
      deps.setSelectedIds,
      calculateTargetFolder,
      handleNoteMove,
      handleFolderMove,
      handleReorderInFolder,
      handleReorderFoldersInParent
    ]
  )

  return {
    // Create
    isCreating,
    isCreatingFolder,
    handleCreateNote,
    handleCreateNoteInFolder,
    handleCreateFolder,
    handleCreateSubfolder,

    // Selection
    handleSelectionChange,
    handleOpenFolderView,

    // Rename notes
    renamingNoteId,
    renameValue,
    isRenaming,
    handleRenameClick,
    handleRenameInputChange,
    handleRenameSubmit,
    handleRenameCancel,

    // Rename folders
    renamingFolderPath,
    folderRenameValue,
    setFolderRenameValue,
    isFolderRenaming,
    handleRenameFolderClick,
    handleFolderRenameSubmit,
    handleFolderRenameCancel,

    // Delete
    notesToDelete,
    foldersToDelete,
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    handleDeleteClick,
    handleDeleteFolderClick,
    handleBulkDelete,
    handleDeleteConfirm,

    // External
    handleOpenExternal,
    handleRevealInFinder,

    // Templates
    folderToConfigureTemplate,
    handleSetFolderTemplate,
    handleFolderTemplateSelect,
    handleClearFolderTemplate,

    // Icon picker
    iconPickerFolderPath,
    setIconPickerFolderPath,

    // Move / Drag-drop
    isMoving,
    handleMove
  }
}
