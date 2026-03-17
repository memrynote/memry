import { useState, useMemo } from 'react'
import { Folder, Check, ChevronDown, Sparkles, Loader2, FileText, Link2 } from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import type { Folder as FolderType } from '@/types'

type SuggestedFolder = FolderType & { aiConfidence?: number; aiReason?: string }

interface NoteSuggestion {
  note: { id: string; title: string; snippet: string }
  confidence: number
  reason: string
}

interface TriageFilePickerProps {
  itemId: string
  onSelect: (folder: FolderType) => void
  onLinkToNote?: (noteId: string) => void
  onCancel: () => void
}

export function TriageFilePicker({
  itemId,
  onSelect,
  onLinkToNote,
  onCancel
}: TriageFilePickerProps): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [linkedNoteId, setLinkedNoteId] = useState<string | null>(null)

  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const paths = await window.api.notes.getFolders()
      const folders: FolderType[] = [{ id: '', name: 'Notes (root)', path: '' }]
      for (const p of paths) {
        if (p) {
          folders.push({
            id: p,
            name: p.split('/').pop() || p,
            path: p,
            parent: p.includes('/') ? p.split('/').slice(0, -1).join('/') : undefined
          })
        }
      }
      return folders
    }
  })

  const { data: rawSuggestions = [], isLoading: isLoadingAI } = useQuery({
    queryKey: ['inbox', 'suggestions', itemId],
    queryFn: async () => {
      const response = await window.api.inbox.getSuggestions(itemId)
      return response.suggestions || []
    },
    staleTime: 60_000
  })

  const aiSuggestions = useMemo<SuggestedFolder[]>(
    () =>
      rawSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path !== undefined)
        .slice(0, 3)
        .map((s) => {
          const folderPath = s.destination.path || ''
          return {
            id: folderPath,
            name: folderPath.split('/').pop() || folderPath || 'Notes (root)',
            path: folderPath,
            aiConfidence: s.confidence,
            aiReason: s.reason
          } satisfies SuggestedFolder
        }),
    [rawSuggestions]
  )

  const noteSuggestions = useMemo<NoteSuggestion[]>(
    () =>
      rawSuggestions
        .filter((s) => s.destination.type === 'note' && s.suggestedNote)
        .slice(0, 3)
        .map((s) => ({
          note: s.suggestedNote!,
          confidence: s.confidence,
          reason: s.reason
        })),
    [rawSuggestions]
  )

  const filteredFolders = search
    ? vaultFolders.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    : vaultFolders

  const handleSelect = (folder: FolderType): void => {
    setSelectedPath(folder.path ?? null)
    setLinkedNoteId(null)
    onSelect(folder)
  }

  const handleLinkNote = (noteId: string): void => {
    setLinkedNoteId(noteId)
    setSelectedPath(null)
    onLinkToNote?.(noteId)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        <Folder className="size-3.5" />
        <span>File to folder</span>
        {isLoadingAI && <Loader2 className="size-3 animate-spin" />}
      </div>

      {aiSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {aiSuggestions.map((folder, i) => {
            const isSelected = selectedPath === folder.path
            const confidence = folder.aiConfidence ? Math.round(folder.aiConfidence * 100) : null
            return (
              <button
                key={folder.id}
                type="button"
                onClick={() => handleSelect(folder)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border hover:bg-accent'
                )}
              >
                <Sparkles className="size-3 opacity-60" />
                <span className="text-[10px] font-bold opacity-60">{i + 1}</span>
                <span className="max-w-[100px] truncate">{folder.name}</span>
                {confidence && !isSelected && (
                  <span className="text-[10px] opacity-50">{confidence}%</span>
                )}
                {isSelected && <Check className="size-3" />}
              </button>
            )
          })}
        </div>
      )}

      {!showAll ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          <ChevronDown className="size-3" />
          Other folders
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search folders…"
            className="border-border bg-background placeholder:text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs"
            autoFocus
          />
          <div className="max-h-40 overflow-y-auto">
            {filteredFolders.map((folder) => (
              <button
                key={folder.id || 'root'}
                type="button"
                onClick={() => handleSelect(folder)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors',
                  selectedPath === folder.path
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-accent text-foreground'
                )}
              >
                <Folder className="size-3 shrink-0" />
                <span className="truncate">{folder.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {noteSuggestions.length > 0 && (
        <>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
            <Link2 className="size-3.5" />
            <span>Link to note</span>
          </div>

          <div className="flex flex-col gap-1.5">
            {noteSuggestions.map((suggestion) => {
              const isLinked = linkedNoteId === suggestion.note.id
              return (
                <button
                  key={suggestion.note.id}
                  type="button"
                  onClick={() => handleLinkNote(suggestion.note.id)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors',
                    isLinked
                      ? 'bg-primary/10 border-primary/30'
                      : 'bg-background border-border hover:bg-accent'
                  )}
                >
                  <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{suggestion.note.title}</span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {Math.round(suggestion.confidence * 100)}%
                      </span>
                      {isLinked && <Check className="size-3 shrink-0 text-primary" />}
                    </div>
                    {suggestion.note.snippet && (
                      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {suggestion.note.snippet}
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
