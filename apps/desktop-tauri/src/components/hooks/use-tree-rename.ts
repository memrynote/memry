import { useState, useRef, useCallback } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { Note } from '@memry/contracts/notes-api'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { notesKeys } from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { getDisplayName } from '../notes-tree-utils'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:useTreeRename')

interface UseTreeRenameOptions {
  renameNoteMutateAsync: (input: { id: string; newTitle: string }) => Promise<unknown>
  updateTabTitleByEntityId: (entityId: string, title: string) => void
  queryClient: QueryClient
  refreshFolders: () => Promise<unknown>
}

export function useTreeRename({
  renameNoteMutateAsync,
  updateTabTitleByEntityId,
  queryClient,
  refreshFolders
}: UseTreeRenameOptions) {
  // Note rename state
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const originalRenameTitle = useRef<string>('')

  // Folder rename state
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [isFolderRenaming, setIsFolderRenaming] = useState(false)
  const folderRenameInputRef = useRef<HTMLInputElement>(null)

  const renameCallbackRef = useCallback((el: HTMLInputElement | null) => {
    renameInputRef.current = el
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.select()
      })
    }
  }, [])

  const folderRenameCallbackRef = useCallback((el: HTMLInputElement | null) => {
    folderRenameInputRef.current = el
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.select()
      })
    }
  }, [])

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
        toast.error(extractErrorMessage(err, 'Failed to rename note'))
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
        toast.error(extractErrorMessage(err, 'Failed to rename folder'))
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

  return {
    // Note rename
    renamingNoteId,
    setRenamingNoteId,
    renameValue,
    setRenameValue,
    isRenaming,
    renameCallbackRef,
    originalRenameTitle,
    handleRenameClick,
    handleRenameInputChange,
    handleRenameSubmit,
    handleRenameCancel,
    // Folder rename
    renamingFolderPath,
    setRenamingFolderPath,
    folderRenameValue,
    setFolderRenameValue,
    isFolderRenaming,
    folderRenameCallbackRef,
    handleRenameFolderClick,
    handleFolderRenameSubmit,
    handleFolderRenameCancel
  }
}
