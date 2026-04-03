import { useMemo, useState, useEffect } from 'react'
import {
  useNotesList,
  useNoteFoldersQuery,
  useNoteMutations,
  type NoteListItem
} from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import { buildTreeFromNotes, type TreeStructure } from '@/components/notes-tree-utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:NoteTreeData')

export interface NoteTreeData {
  notes: NoteListItem[]
  isLoading: boolean
  error: Error | null
  folders: ReturnType<typeof useNoteFoldersQuery>['folders']
  createFolder: ReturnType<typeof useNoteFoldersQuery>['createFolder']
  setFolderIcon: ReturnType<typeof useNoteFoldersQuery>['setFolderIcon']
  refreshFolders: ReturnType<typeof useNoteFoldersQuery>['refetch']
  mutations: ReturnType<typeof useNoteMutations>
  tree: TreeStructure
  noteMap: Map<string, NoteListItem>
  notePositions: Record<string, number>
  setNotePositions: React.Dispatch<React.SetStateAction<Record<string, number>>>
  folderTemplateNames: Map<string, string>
  setFolderTemplateNames: React.Dispatch<React.SetStateAction<Map<string, string>>>
  computeTargetFolder: (selectedIds: string[]) => string
}

export function useNoteTreeData(): NoteTreeData {
  const { notes, isLoading, error } = useNotesList({ limit: 10000 })
  const mutations = useNoteMutations()
  const { folders, createFolder, setFolderIcon, refetch: refreshFolders } = useNoteFoldersQuery()

  const [folderTemplateNames, setFolderTemplateNames] = useState<Map<string, string>>(new Map())
  const [notePositions, setNotePositions] = useState<Record<string, number>>({})

  useEffect(() => {
    const loadFolderTemplateNames = async () => {
      if (folders.length === 0) return

      try {
        const templatesResponse = await window.api.templates.list()
        const templatesMap = new Map(templatesResponse.templates.map((t) => [t.id, t.name]))

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

  const tree = useMemo(() => {
    return buildTreeFromNotes(notes, folders, notePositions)
  }, [notes, folders, notePositions])

  const noteMap = useMemo(() => {
    const map = new Map<string, NoteListItem>()
    notes.forEach((note) => map.set(note.id, note))
    return map
  }, [notes])

  const computeTargetFolder = useMemo(() => {
    return (selectedIds: string[]): string => {
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
    }
  }, [noteMap])

  return {
    notes,
    isLoading,
    error,
    folders,
    createFolder,
    setFolderIcon,
    refreshFolders,
    mutations,
    tree,
    noteMap,
    notePositions,
    setNotePositions,
    folderTemplateNames,
    setFolderTemplateNames,
    computeTargetFolder
  }
}
