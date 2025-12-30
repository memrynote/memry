/**
 * Compact Filing Section for Inbox Detail Panel
 * Provides folder selection, tags, and note linking in a compact layout
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Folder,
  Link2,
  Sparkles,
  Loader2,
  ChevronDown,
  Check,
  X,
  Plus
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { cn } from '@/lib/utils'
import type { InboxItem, InboxItemListItem, Folder as FolderType, LinkedNote } from '@/types'

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
// Compact Folder Chip Component
// =============================================================================

interface FolderChipProps {
  folder: SuggestedFolder
  index: number
  isSelected: boolean
  onClick: () => void
}

const FolderChip = ({ folder, index, isSelected, onClick }: FolderChipProps): React.JSX.Element => {
  const confidence = folder.aiConfidence ? Math.round(folder.aiConfidence * 100) : null

  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
        'border hover:bg-accent',
        isSelected
          ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
          : 'bg-background border-border text-foreground'
      )}
    >
      <span className="text-[10px] font-bold opacity-60">{index + 1}</span>
      <span className="truncate max-w-[100px]">{folder.name || 'Notes'}</span>
      {confidence && !isSelected && (
        <span className="text-[10px] opacity-50">{confidence}%</span>
      )}
      {isSelected && <Check className="size-3" />}
    </button>
  )
}

// =============================================================================
// Compact Link Input Component
// =============================================================================

interface CompactLinkInputProps {
  linkedNotes: LinkedNote[]
  onLinkedNotesChange: (notes: LinkedNote[]) => void
}

const CompactLinkInput = ({
  linkedNotes,
  onLinkedNotesChange
}: CompactLinkInputProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Fetch notes for search
  const { data: searchResults = [] } = useQuery({
    queryKey: ['notes', 'search', searchQuery],
    queryFn: async () => {
      if (!searchQuery || searchQuery.length < 2) return []
      const results = await window.api.search.searchNotes(searchQuery, { limit: 10 })
      return results.map((note) => ({
        id: note.id,
        title: note.title,
        type: 'note' as const
      }))
    },
    enabled: searchQuery.length >= 2
  })

  // Filter out already linked notes from search results
  const availableResults = searchResults.filter(
    (note) => !linkedNotes.find((n) => n.id === note.id)
  )

  const handleSelectNote = (note: LinkedNote): void => {
    if (!linkedNotes.find((n) => n.id === note.id)) {
      onLinkedNotesChange([...linkedNotes, note])
    }
    // Keep popover open and clear search for adding more notes
    setSearchQuery('')
  }

  const handleRemoveNote = (noteId: string): void => {
    onLinkedNotesChange(linkedNotes.filter((n) => n.id !== noteId))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {linkedNotes.map((note) => (
        <Badge
          key={note.id}
          variant="outline"
          className="text-xs px-2 py-0.5 gap-1"
        >
          <Link2 className="size-3" />
          <span className="truncate max-w-[80px]">{note.title}</span>
          <button
            onClick={() => handleRemoveNote(note.id)}
            className="hover:text-destructive"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3 mr-1" />
            Link
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <Input
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 text-xs mb-2"
            autoFocus
          />
          <ScrollArea className="max-h-48">
            {/* Show linked notes count */}
            {linkedNotes.length > 0 && (
              <p className="text-[10px] text-muted-foreground px-2 py-1 border-b mb-1">
                {linkedNotes.length} note{linkedNotes.length > 1 ? 's' : ''} linked
              </p>
            )}

            {searchQuery.length >= 2 ? (
              availableResults.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-2">
                  {searchResults.length > 0 ? 'All matches already linked' : 'No notes found'}
                </p>
              ) : (
                <div className="space-y-1">
                  {availableResults.map((note) => (
                    <button
                      key={note.id}
                      onClick={() => handleSelectNote(note)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-accent text-left"
                    >
                      <Link2 className="size-3 shrink-0" />
                      <span className="truncate flex-1">{note.title}</span>
                      <Plus className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2">
                Type to search notes...
              </p>
            )}
          </ScrollArea>

          {/* Done button when notes are linked */}
          {linkedNotes.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsOpen(false)}
              className="w-full mt-2 h-7 text-xs"
            >
              <Check className="size-3 mr-1" />
              Done
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
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
      const paths = await window.api.notes.getFolders()
      const folders: FolderType[] = [{ id: '', name: 'Notes (root)', path: '' }]
      for (const path of paths) {
        if (path) {
          folders.push({
            id: path,
            name: path.split('/').pop() || path,
            path: path,
            parent: path.includes('/') ? path.split('/').slice(0, -1).join('/') : undefined
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
        console.error('Failed to fetch AI suggestions:', error)
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

  const hasAISuggestions = aiSuggestions.length > 0

  // Filter folders based on search query
  const filteredFolders = useMemo(() => {
    if (!folderSearch.trim()) return vaultFolders
    const query = folderSearch.toLowerCase()
    return vaultFolders.filter(
      (f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)
    )
  }, [vaultFolders, folderSearch])

  // Check if selected folder is from "Other" dropdown (not a suggested chip)
  const isSelectedFromOther =
    selectedFolder && !suggestedFolders.some((f) => f.id === selectedFolder.id)

  return (
    <div className={cn('space-y-3', className)}>
      {/* Header Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <Folder className="size-3.5" />
          <span>File to</span>
        </div>
        {isLoadingAISuggestions ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
          </div>
        ) : hasAISuggestions ? (
          <div className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-500">
            <Sparkles className="size-3" />
            <span>AI</span>
          </div>
        ) : null}
      </div>

      {/* Folder Suggestions as Chips */}
      <div className="flex flex-wrap items-center gap-2">
        {suggestedFolders.map((folder, index) => (
          <FolderChip
            key={folder.id || `folder-${index}`}
            folder={folder}
            index={index}
            isSelected={selectedFolder?.id === folder.id}
            onClick={() => onFolderSelect(folder)}
          />
        ))}

        {/* Other Folder Dropdown */}
        <Popover
          open={showAllFolders}
          onOpenChange={(open) => {
            setShowAllFolders(open)
            if (!open) setFolderSearch('')
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant={isSelectedFromOther ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-2 text-xs"
            >
              {isSelectedFromOther ? (
                <>
                  <Folder className="size-3 mr-1" />
                  <span className="truncate max-w-[100px]">{selectedFolder.name}</span>
                </>
              ) : (
                'Other'
              )}
              <ChevronDown className="size-3 ml-1" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="start">
            <Input
              placeholder="Search folders..."
              value={folderSearch}
              onChange={(e) => setFolderSearch(e.target.value)}
              className="h-8 text-xs mb-2"
              autoFocus
            />
            <ScrollArea className="max-h-48">
              {filteredFolders.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-2">
                  No folders found
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredFolders.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => {
                        onFolderSelect(folder)
                        setShowAllFolders(false)
                      }}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-left',
                        selectedFolder?.id === folder.id
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-accent'
                      )}
                    >
                      <Folder className="size-3 shrink-0" />
                      <span className="truncate flex-1">{folder.name}</span>
                      {selectedFolder?.id === folder.id && (
                        <Check className="size-3 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>

      {/* Tags & Links Row - Side by Side */}
      <div className="grid grid-cols-2 gap-4 pt-2">
        {/* Tags - Using existing TagAutocomplete */}
        <div className="min-w-0">
          <TagAutocomplete
            tags={tags}
            onTagsChange={onTagsChange}
            placeholder="Add tags..."
            showSections={false}
            maxSuggestions={5}
            className="[&>div:first-child]:hidden [&>div]:space-y-1.5"
          />
        </div>

        {/* Links */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
            <Link2 className="size-3" />
            <span>Links</span>
          </div>
          <CompactLinkInput
            linkedNotes={linkedNotes}
            onLinkedNotesChange={onLinkedNotesChange}
          />
        </div>
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
