/**
 * Compact Filing Section for Inbox Detail Panel
 * Provides folder selection, tags, and note linking in a compact layout
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Folder, Sparkles, Loader2, ChevronDown, Check, FileText, Link2, Search } from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { LinkInput } from './link-input'
import { cn } from '@/lib/utils'
import type { InboxItem, InboxItemListItem, Folder as FolderType, LinkedNote } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:FilingSection')

// Filing section can work with either full or list item types
type FilingItem = InboxItem | InboxItemListItem

// Extended folder type with AI metadata
type SuggestedFolder = FolderType & { aiConfidence?: number; aiReason?: string }

// =============================================================================
// Types
// =============================================================================

interface FilingSectionProps {
  item: FilingItem | null
  selectedFolder: FolderType | null
  tags: string[]
  linkedNotes: LinkedNote[]
  onFolderSelect: (folder: FolderType) => void
  onTagsChange: (tags: string[]) => void
  onLinkedNotesChange: (notes: LinkedNote[]) => void
  className?: string
}

// =============================================================================
// Filing Section Component
// =============================================================================

export const FilingSection = ({
  item,
  selectedFolder,
  tags,
  linkedNotes,
  onFolderSelect,
  onTagsChange,
  onLinkedNotesChange,
  className
}: FilingSectionProps): React.JSX.Element => {
  const [showAllFolders, setShowAllFolders] = useState(false)
  const [folderSearch, setFolderSearch] = useState('')

  // Fetch real folders from vault
  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const folderInfos = await window.api.notes.getFolders()
      const folders: FolderType[] = [{ id: '', name: 'Notes (root)', path: '' }]
      for (const fi of folderInfos) {
        if (fi.path) {
          folders.push({
            id: fi.path,
            name: fi.path.split('/').pop() || fi.path,
            path: fi.path,
            parent: fi.path.includes('/') ? fi.path.split('/').slice(0, -1).join('/') : undefined
          })
        }
      }
      return folders
    },
    enabled: item !== null
  })

  // Fetch AI-powered filing suggestions
  const { data: aiSuggestions = [], isLoading: isLoadingAISuggestions } = useQuery({
    queryKey: ['inbox', 'suggestions', item?.id],
    queryFn: async () => {
      if (!item?.id) return []
      try {
        const response = await window.api.inbox.getSuggestions(item.id)
        return response.suggestions || []
      } catch (error) {
        log.error('Failed to fetch AI suggestions', error)
        return []
      }
    },
    enabled: item !== null && !!item?.id,
    staleTime: 30000
  })

  // Convert AI suggestions to folder objects with confidence metadata
  const suggestedFolders = useMemo((): SuggestedFolder[] => {
    if (aiSuggestions.length > 0) {
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 3) // Show max 3 suggestions
        .map((s) => {
          const path = s.destination.path || ''
          return {
            id: path,
            name: path.split('/').pop() || path || 'Notes',
            path: path,
            aiConfidence: s.confidence,
            aiReason: s.reason
          }
        })
    }
    // Fallback to first 3 folders if no AI suggestions
    return vaultFolders.slice(0, 3).map((f) => ({ ...f }))
  }, [aiSuggestions, vaultFolders])

  const noteSuggestions = useMemo(() => {
    return aiSuggestions
      .filter((s) => s.destination.type === 'note' && s.suggestedNote)
      .slice(0, 3)
      .map((s) => ({
        note: s.suggestedNote!,
        confidence: s.confidence,
        reason: s.reason
      }))
  }, [aiSuggestions])

  const aiSuggestedTags = useMemo(() => {
    if (aiSuggestions.length === 0) return []
    return aiSuggestions.flatMap((s) => s.suggestedTags || []).filter(Boolean)
  }, [aiSuggestions])

  const hasAISuggestions = aiSuggestions.length > 0

  // Track whether auto-selection already fired for this item
  const didAutoSelectFolder = useRef(false)
  // Reset flags when item changes
  useEffect(() => {
    didAutoSelectFolder.current = false
  }, [item?.id])

  // Auto-select top AI-suggested folder (once per item)
  useEffect(() => {
    if (!didAutoSelectFolder.current && suggestedFolders.length > 0 && !selectedFolder) {
      didAutoSelectFolder.current = true
      onFolderSelect(suggestedFolders[0])
    }
  }, [suggestedFolders, selectedFolder, onFolderSelect])

  // Derive display info for the folder dropdown trigger
  const displayFolder = selectedFolder
    ? (suggestedFolders.find((f) => f.id === selectedFolder.id) ?? {
        ...selectedFolder,
        aiConfidence: undefined
      })
    : (suggestedFolders[0] ?? null)
  const displayConfidence = (displayFolder as SuggestedFolder | null)?.aiConfidence
    ? Math.round((displayFolder as SuggestedFolder).aiConfidence! * 100)
    : null
  const displayPath = displayFolder?.path
    ? displayFolder.path.replace(/\//g, ' / ')
    : displayFolder?.name || 'Select folder'

  const handleLinkSuggestedNote = useCallback(
    (note: { id: string; title: string }) => {
      const alreadyLinked = linkedNotes.some((ln) => ln.id === note.id)
      if (alreadyLinked) {
        onLinkedNotesChange(linkedNotes.filter((ln) => ln.id !== note.id))
        return
      }
      onLinkedNotesChange([...linkedNotes, { id: note.id, title: note.title, type: 'note' }])
    },
    [linkedNotes, onLinkedNotesChange]
  )

  // Filter folders based on search query
  const filteredFolders = useMemo(() => {
    if (!folderSearch.trim()) return vaultFolders
    const query = folderSearch.toLowerCase()
    return vaultFolders.filter(
      (f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)
    )
  }, [vaultFolders, folderSearch])

  return (
    <div className={cn(className)}>
      {/* File To — Header + Dropdown */}
      <div className="flex flex-col gap-2 py-4 px-5 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
            File to
          </span>
          {isLoadingAISuggestions ? (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
            </div>
          ) : hasAISuggestions ? (
            <div className="flex items-center gap-1 text-[11px] text-[var(--tint)]">
              <Sparkles className="size-3" />
              <span>AI</span>
            </div>
          ) : null}
        </div>

        {/* Folder Dropdown */}
        <Popover
          open={showAllFolders}
          onOpenChange={(open) => {
            setShowAllFolders(open)
            if (!open) setFolderSearch('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              className={cn(
                'flex items-center w-full rounded-md py-2.5 px-3.5 transition-colors',
                hasAISuggestions
                  ? 'bg-[var(--tint)]/[0.03] border border-[var(--tint)]/12'
                  : 'bg-foreground/[0.02] border border-border'
              )}
            >
              <div className="flex items-center grow gap-2 min-w-0">
                <Folder
                  className={cn(
                    'size-4 shrink-0',
                    hasAISuggestions ? 'text-[var(--tint)]' : 'text-muted-foreground'
                  )}
                />
                <span className="text-[13px] leading-4 font-medium text-foreground truncate">
                  {displayPath}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {displayConfidence && (
                  <span className="text-[11px] leading-3.5 text-[var(--tint)]/50">
                    {displayConfidence}%
                  </span>
                )}
                <ChevronDown className="size-3 text-muted-foreground/50" />
              </div>
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-0 rounded-md bg-[var(--popover)] border-border shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
            align="start"
            sideOffset={4}
          >
            {/* Search */}
            <div className="flex items-center py-2.5 px-3 gap-2 border-b border-border/40">
              <Search className="size-3.5 text-muted-foreground/40 shrink-0" />
              <Input
                placeholder="Search folders..."
                value={folderSearch}
                onChange={(e) => setFolderSearch(e.target.value)}
                className="h-auto p-0 border-0 bg-transparent text-[13px] leading-4 text-foreground placeholder:text-muted-foreground/30 focus-visible:border-transparent shadow-none"
                autoFocus
              />
            </div>

            <ScrollArea className="max-h-56">
              {/* Suggested section */}
              {suggestedFolders.length > 0 && !folderSearch.trim() && (
                <div className="flex flex-col py-1">
                  <div className="flex items-center py-0.5 px-2">
                    <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
                      Suggested
                    </span>
                  </div>
                  {suggestedFolders.map((folder) => {
                    const confidence = folder.aiConfidence
                      ? Math.round(folder.aiConfidence * 100)
                      : null
                    const isSelected = selectedFolder?.id === folder.id
                    return (
                      <button
                        key={folder.id || 'root-suggested'}
                        onClick={() => {
                          onFolderSelect(folder)
                          setShowAllFolders(false)
                        }}
                        className={cn(
                          'flex items-center gap-2 rounded-sm py-2 px-3 mx-1 my-0.5 text-left transition-colors',
                          isSelected ? 'bg-[var(--tint)]/[0.03]' : 'hover:bg-foreground/[0.03]'
                        )}
                      >
                        <Folder className="size-3.5 shrink-0 text-[var(--tint)]" />
                        <div className="flex flex-col grow gap-px min-w-0">
                          <span className="text-[13px] leading-4 font-medium text-foreground truncate">
                            {folder.name || 'Notes'}
                          </span>
                          {folder.path && (
                            <span className="text-[11px] leading-3.5 text-muted-foreground/60 truncate">
                              {folder.path.replace(/\//g, ' / ')}
                            </span>
                          )}
                        </div>
                        {confidence && (
                          <span className="text-[10px] leading-3 text-[var(--tint)]/50 shrink-0">
                            {confidence}%
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}

              {/* All folders section */}
              <div
                className={cn(
                  'flex flex-col py-1',
                  suggestedFolders.length > 0 && !folderSearch.trim() && 'border-t border-border/40'
                )}
              >
                {!folderSearch.trim() && (
                  <div className="flex items-center py-0.5 px-2">
                    <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
                      All folders
                    </span>
                  </div>
                )}
                {filteredFolders.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-3">No folders found</p>
                ) : (
                  filteredFolders.map((folder) => {
                    const isSelected = selectedFolder?.id === folder.id
                    const parentPath = folder.path?.includes('/')
                      ? folder.path.split('/').slice(0, -1).join(' / ')
                      : null
                    return (
                      <button
                        key={folder.id}
                        onClick={() => {
                          onFolderSelect(folder)
                          setShowAllFolders(false)
                        }}
                        className={cn(
                          'flex items-center gap-2 rounded-sm py-2 px-3 mx-1 my-0.5 text-left transition-colors',
                          isSelected ? 'bg-foreground/[0.03]' : 'hover:bg-foreground/[0.03]'
                        )}
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="grow text-[13px] leading-4 text-foreground truncate">
                          {folder.name}
                        </span>
                        {parentPath && (
                          <span className="text-[10px] leading-3 text-muted-foreground/30 shrink-0">
                            {parentPath}
                          </span>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </ScrollArea>

            {/* Footer hints */}
            <div className="flex items-center py-2 px-3 border-t border-border/40">
              <span className="text-[10px] leading-3 text-muted-foreground/30">
                ↑↓ navigate · ⏎ select · esc close
              </span>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Tags */}
      <TagAutocomplete
        tags={tags}
        onTagsChange={onTagsChange}
        placeholder="Add tags..."
        showSections={false}
        maxSuggestions={5}
        aiSuggestedTags={aiSuggestedTags}
      />

      {/* Link to note */}
      <div className="flex flex-col gap-2 py-4 px-5 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
            Link to note
          </span>
          {noteSuggestions.length > 0 && (
            <div className="flex items-center gap-1 text-[11px] text-[var(--tint)]">
              <Sparkles className="size-3" />
              <span>AI</span>
            </div>
          )}
        </div>

        {/* AI Note Suggestions */}
        {noteSuggestions.length > 0 && (
          <div className="space-y-1.5">
            {noteSuggestions.map((suggestion, index) => {
              const isLinked = linkedNotes.some((ln) => ln.id === suggestion.note.id)
              const bgOpacity = [0.05, 0.02, 0.01][index] ?? 0.01
              const borderOpacity = [0.12, 0.06, 0.03][index] ?? 0.03
              return (
                <button
                  key={suggestion.note.id}
                  onClick={() => handleLinkSuggestedNote(suggestion.note)}
                  className="w-full flex items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors border border-dashed"
                  style={{
                    backgroundColor: `color-mix(in srgb, var(--tint) ${Math.round(bgOpacity * 100)}%, transparent)`,
                    borderColor: isLinked
                      ? `color-mix(in srgb, var(--tint) 50%, transparent)`
                      : `color-mix(in srgb, var(--tint) ${Math.round(borderOpacity * 100)}%, transparent)`
                  }}
                >
                  {linkedNotes.find((ln) => ln.id === suggestion.note.id)?.emoji ? (
                    <NoteIconDisplay
                      value={linkedNotes.find((ln) => ln.id === suggestion.note.id)!.emoji!}
                      className="size-3.5 shrink-0"
                    />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-[13px] leading-4 font-medium text-foreground flex-1 min-w-0">
                    {suggestion.note.title}
                  </span>
                  {isLinked && <Check className="size-3 shrink-0 text-[var(--tint)]" />}
                  <span className="text-[10px] leading-3 text-muted-foreground/40 shrink-0">
                    {Math.round(suggestion.confidence * 100)}%
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Link notes search input */}
        <LinkInput linkedNotes={linkedNotes} onLinkedNotesChange={onLinkedNotesChange} />
      </div>
    </div>
  )
}

// =============================================================================
// Hook for managing filing state
// =============================================================================

interface UseFilingStateOptions {
  item: FilingItem | null
  isOpen: boolean
}

interface UseFilingStateReturn {
  selectedFolder: FolderType | null
  tags: string[]
  linkedNotes: LinkedNote[]
  setSelectedFolder: (folder: FolderType | null) => void
  setTags: (tags: string[]) => void
  setLinkedNotes: (notes: LinkedNote[]) => void
  resetFilingState: () => void
  canFile: boolean
}

export const useFilingState = ({ item, isOpen }: UseFilingStateOptions): UseFilingStateReturn => {
  const [selectedFolder, setSelectedFolder] = useState<FolderType | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [linkedNotes, setLinkedNotes] = useState<LinkedNote[]>([])

  // Reset state when item changes or panel closes
  useEffect(() => {
    if (isOpen && item) {
      setSelectedFolder(null)
      setTags(item.tags || [])
      setLinkedNotes([])
    }
  }, [isOpen, item?.id])

  const resetFilingState = useCallback(() => {
    setSelectedFolder(null)
    setTags([])
    setLinkedNotes([])
  }, [])

  const canFile = selectedFolder !== null

  return {
    selectedFolder,
    tags,
    linkedNotes,
    setSelectedFolder,
    setTags,
    setLinkedNotes,
    resetFilingState,
    canFile
  }
}
