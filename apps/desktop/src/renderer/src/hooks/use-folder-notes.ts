/**
 * Folder Notes Hook (Home Dashboard widget)
 *
 * Thin read-only hook fetching a folder's notes with properties for the Folder
 * widget. Mirrors useFolderView's notes query but drops all view/column/formula/
 * pagination machinery. Disabled when folderPath is empty.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

export interface UseFolderNotesOptions {
  folderPath: string
  limit?: number
  sortBy?: 'title' | 'modified' | 'created'
  sortOrder?: 'asc' | 'desc'
}

export interface UseFolderNotesResult {
  notes: NoteWithProperties[]
  isLoading: boolean
  error: Error | null
}

const EMPTY_NOTES: NoteWithProperties[] = []

export function useFolderNotes({
  folderPath,
  limit = 24,
  sortBy = 'modified',
  sortOrder = 'desc'
}: UseFolderNotesOptions): UseFolderNotesResult {
  const enabled = folderPath.trim().length > 0

  const query = useQuery({
    queryKey: ['folder-notes', folderPath, limit, sortBy, sortOrder] as const,
    queryFn: async (): Promise<NoteWithProperties[]> => {
      const result = await window.api.folderView.listWithProperties({
        scope: { kind: 'folder', path: folderPath },
        properties: undefined,
        limit,
        offset: 0
      })
      const sorted = sortNotes(result.notes, sortBy, sortOrder)
      return sorted.slice(0, limit)
    },
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000
  })

  const notes = useMemo(() => query.data ?? EMPTY_NOTES, [query.data])

  return {
    notes,
    isLoading: query.isLoading,
    error: query.error
  }
}

function sortNotes(
  notes: NoteWithProperties[],
  sortBy: 'title' | 'modified' | 'created',
  sortOrder: 'asc' | 'desc'
): NoteWithProperties[] {
  const dir = sortOrder === 'asc' ? 1 : -1
  return [...notes].sort((a, b) => {
    if (sortBy === 'title') return a.title.localeCompare(b.title) * dir
    return a[sortBy].localeCompare(b[sortBy]) * dir
  })
}
