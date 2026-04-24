import { useState, useCallback } from 'react'
import type { NoteListItem } from '@/hooks/use-notes-query'
import type { TreeStructure } from '@/lib/virtualized-tree-utils'
import type { MoveOperation, DropPosition } from '@/components/kibo-ui/tree'
import {
  extractFolderFromPath,
  getParentFolder,
  isDescendantOrSelf,
  getNotesInFolder,
  getFoldersInParent
} from '../notes-tree-utils'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:useTreeDragDrop')

interface UseTreeDragDropOptions {
  tree: TreeStructure
  noteMap: Map<string, NoteListItem>
  selectedIds: string[]
  setSelectedIds: (ids: string[]) => void
  setNotePositions: (positions: Record<string, number>) => void
  moveNoteMutateAsync: (input: { id: string; newFolder: string }) => Promise<unknown>
  refreshFolders: () => Promise<unknown>
}

export function useTreeDragDrop({
  tree,
  noteMap,
  selectedIds,
  setSelectedIds,
  setNotePositions,
  moveNoteMutateAsync,
  refreshFolders
}: UseTreeDragDropOptions) {
  const [isMoving, setIsMoving] = useState(false)

  const calculateTargetFolder = useCallback(
    (targetId: string, position: DropPosition): string => {
      if (targetId === 'notes-root' || targetId === '') {
        return ''
      }

      if (targetId.startsWith('folder-')) {
        const folderPath = targetId.replace('folder-', '')
        if (position === 'inside') {
          return folderPath
        } else {
          return getParentFolder(folderPath)
        }
      }

      const targetNote = noteMap.get(targetId)
      if (targetNote) {
        return extractFolderFromPath(targetNote.path)
      }

      return ''
    },
    [noteMap]
  )

  const handleNoteMove = useCallback(
    async (noteId: string, targetFolder: string): Promise<boolean> => {
      const note = noteMap.get(noteId)
      if (!note) return false

      const currentFolder = extractFolderFromPath(note.path)
      if (currentFolder === targetFolder) {
        return false
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
        const targetNote = noteMap.get(targetId)
        if (targetNote) {
          const targetFolder = extractFolderFromPath(targetNote.path)
          newPath = targetFolder ? `${targetFolder}/${sourceFolderName}` : sourceFolderName
        } else {
          newPath = sourceFolderName
        }
      }

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

        if (
          foldersToMove.length === 1 &&
          notesToMove.length === 0 &&
          targetId.startsWith('folder-') &&
          (position === 'before' || position === 'after')
        ) {
          const draggedFolderPath = foldersToMove[0]
          const targetFolderPath = targetId.replace('folder-', '')

          const draggedParent = getParentFolder(draggedFolderPath)
          const targetParent = getParentFolder(targetFolderPath)

          if (draggedParent === targetParent) {
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

        for (const folderPath of foldersToMove) {
          await handleFolderMove(folderPath, targetId, position)
        }

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
      noteMap,
      setSelectedIds
    ]
  )

  return { isMoving, handleMove }
}
