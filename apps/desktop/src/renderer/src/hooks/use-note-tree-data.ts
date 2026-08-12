import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
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

/**
 * How many notes one sidebar page pulls.
 *
 * The ceiling stays deliberately bounded: the tree needs the whole array in the
 * renderer to build folder structure, and this list is invalidated and refetched
 * on every note create/update/rename/move, so an unbounded fetch would make a
 * huge vault pay for the entire note set on every keystroke-driven write. What
 * changes here is that the overflow is now reported and reachable on demand
 * instead of being dropped without a trace.
 */
export const NOTE_TREE_PAGE_SIZE = 10000

interface LoadedPage {
  notes: NoteListItem[]
  total: number
  hasMore: boolean
}

const EMPTY_PAGE: LoadedPage = { notes: [], total: 0, hasMore: false }

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
  /** Notes in the vault that the pages fetched so far do not cover. */
  hiddenNoteCount: number
  /** True while a `loadMore()` page is in flight and the current tree is still shown. */
  isLoadingMore: boolean
  /** Pull one more page into the tree. No-op once nothing is hidden. */
  loadMore: () => void
}

export function useNoteTreeData(): NoteTreeData {
  const [limit, setLimit] = useState(NOTE_TREE_PAGE_SIZE)

  // `fields: 'tree'` — the sidebar renders path/title/modified/tags/emoji/
  // localOnly/fileType and nothing else, so main skips the snippet and the
  // mime/size pair. At a 10k-note ceiling those are the bulk of the payload,
  // and this list is refetched on every note create/update/rename/move.
  const {
    notes: fetchedNotes,
    total,
    hasMore,
    isLoading: isPageLoading,
    error
  } = useNotesList({ limit, fields: 'tree' })

  // Raising the ceiling changes the query key, so TanStack starts a fresh entry
  // with no data and `isLoading` flips back to true. Hold the page already on
  // screen so "load more" grows the tree instead of collapsing it to a skeleton.
  const loadedPageRef = useRef<LoadedPage>(EMPTY_PAGE)
  if (!isPageLoading && loadedPageRef.current.notes !== fetchedNotes) {
    loadedPageRef.current = { notes: fetchedNotes, total, hasMore }
  }
  const page = loadedPageRef.current
  const notes = page.notes

  const loadMore = useCallback(() => {
    setLimit((current) => current + NOTE_TREE_PAGE_SIZE)
  }, [])

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

    void loadFolderTemplateNames()
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
    void fetchPositions()
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
        return parts.join('/')
      }

      return ''
    }
  }, [noteMap])

  return {
    notes,
    isLoading: isPageLoading && notes.length === 0,
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
    computeTargetFolder,
    hiddenNoteCount: page.hasMore ? Math.max(page.total - notes.length, 0) : 0,
    isLoadingMore: isPageLoading && notes.length > 0,
    loadMore
  }
}
