import { useState, useCallback, type ReactNode } from 'react'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:useTreeDelete')

interface UseTreeDeleteOptions {
  selectedIds: string[]
  setSelectedIds: (ids: string[]) => void
  noteMap: Map<string, NoteListItem>
  deleteNoteMutateAsync: (id: string) => Promise<{ success: boolean }>
  closeTab: (path: string) => void
  refreshFolders: () => Promise<unknown>
}

export function useTreeDelete({
  selectedIds,
  setSelectedIds,
  noteMap,
  deleteNoteMutateAsync,
  closeTab,
  refreshFolders
}: UseTreeDeleteOptions) {
  const [notesToDelete, setNotesToDelete] = useState<NoteListItem[]>([])
  const [foldersToDelete, setFoldersToDelete] = useState<string[]>([])
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

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

    for (const id of selectedIds) {
      if (id.startsWith('folder-')) {
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
      for (const note of notesToDelete) {
        const result = await deleteNoteMutateAsync(note.id)
        if (result.success) {
          closeTab(`/notes/${note.id}`)
        }
      }

      for (const folderPath of foldersToDelete) {
        await notesService.deleteFolder(folderPath)
      }

      if (foldersToDelete.length > 0) {
        await refreshFolders()
      }

      setIsDeleteDialogOpen(false)
      setNotesToDelete([])
      setFoldersToDelete([])
      setSelectedIds([])
    } catch (err) {
      log.error('Failed to delete items', err)
    } finally {
      setIsDeleting(false)
    }
  }, [
    notesToDelete,
    foldersToDelete,
    isDeleting,
    deleteNoteMutateAsync,
    closeTab,
    refreshFolders,
    setSelectedIds
  ])

  return {
    notesToDelete,
    foldersToDelete,
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    handleDeleteClick,
    handleDeleteFolderClick,
    handleBulkDelete,
    handleDeleteConfirm
  }
}
