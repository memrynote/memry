/**
 * Filing Section for Inbox Detail Panel
 * Provides folder selection, tags, and note linking controls
 * Designed to be sticky at the bottom of the panel
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Folder, Tag, Link2, Sparkles, Info, Loader2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FolderSelector } from '@/components/filing/folder-selector'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { LinkSearch } from '@/components/filing/link-search'
import type { InboxItem, InboxItemListItem, Folder as FolderType, LinkedNote } from '@/types'

// Filing section can work with either full or list item types
type FilingItem = InboxItem | InboxItemListItem

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
  // Fetch real folders from vault
  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const paths = await window.api.notes.getFolders()
      // Add root folder option and convert paths to Folder objects
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
    staleTime: 30000 // Cache for 30 seconds
  })

  // Convert AI suggestions to folder objects with confidence metadata
  const suggestedFolders = useMemo(() => {
    if (aiSuggestions.length > 0) {
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 5)
        .map((s) => {
          const path = s.destination.path || ''
          return {
            id: path,
            name: path.split('/').pop() || path || 'Notes',
            path: path,
            aiConfidence: s.confidence,
            aiReason: s.reason
          } as FolderType & { aiConfidence?: number; aiReason?: string }
        })
    }
    // Fallback to first 3 folders if no AI suggestions
    return vaultFolders.slice(0, 3)
  }, [aiSuggestions, vaultFolders])

  return (
    <div className={className}>
      {/* Section Header with AI indicator */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--foreground)]">File to Notes</h3>

        {/* AI Suggestions Indicator */}
        {isLoadingAISuggestions && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            <span>Loading suggestions...</span>
          </div>
        )}

        {aiSuggestions.length > 0 && !isLoadingAISuggestions && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-help">
                  <Sparkles className="size-3 text-yellow-500" />
                  <span>AI suggestions</span>
                  <Info className="size-3" />
                </div>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Suggestions are based on content similarity with your existing notes and filing
                  patterns.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <div className="space-y-4">
        {/* Folder Selection */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <Folder className="size-3.5" aria-hidden="true" />
            <span className="font-medium uppercase tracking-wide">Destination</span>
          </div>
          <FolderSelector
            folders={vaultFolders}
            suggestedFolders={suggestedFolders}
            recentFolders={[]}
            selectedFolder={selectedFolder}
            onSelect={onFolderSelect}
          />
        </div>

        <Separator className="my-3" />

        {/* Tags */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <Tag className="size-3.5" aria-hidden="true" />
            <span className="font-medium uppercase tracking-wide">Tags</span>
          </div>
          <TagAutocomplete
            tags={tags}
            onTagsChange={onTagsChange}
            placeholder="Add tags..."
            showSections={true}
            className="pt-0"
          />
        </div>

        <Separator className="my-3" />

        {/* Link to Notes */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <Link2 className="size-3.5" aria-hidden="true" />
            <span className="font-medium uppercase tracking-wide">Link to notes</span>
          </div>
          <LinkSearch linkedNotes={linkedNotes} onLinkedNotesChange={onLinkedNotesChange} />
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
