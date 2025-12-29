import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link, FileText, Image, Mic, Globe, Check, Loader2, Sparkles, Info } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FolderSelector } from '@/components/filing/folder-selector'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { LinkSearch } from '@/components/filing/link-search'
import { extractDomain } from '@/lib/inbox-utils'
import { isMac, isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import type { InboxItem, InboxItemListItem, InboxItemType, Folder, LinkedNote } from '@/types'

// Filing panel can work with either full or list item types
type FilingItem = InboxItem | InboxItemListItem

// Item preview icon component
const ItemTypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = 'size-5 text-[var(--muted-foreground)]'

  switch (type) {
    case 'link':
      return <Link className={iconClass} aria-hidden="true" />
    case 'note':
      return <FileText className={iconClass} aria-hidden="true" />
    case 'image':
      return <Image className={iconClass} aria-hidden="true" />
    case 'voice':
      return <Mic className={iconClass} aria-hidden="true" />
    case 'clip':
    case 'pdf':
    case 'social':
    default:
      return <FileText className={iconClass} aria-hidden="true" />
  }
}

// Item preview component
interface ItemPreviewProps {
  item: FilingItem
}

const ItemPreview = ({ item }: ItemPreviewProps): React.JSX.Element => {
  const getSubtitle = (): string => {
    // Get duration - on list items it's a direct property, on full items it's in metadata
    let duration = 0
    if ('duration' in item && typeof item.duration === 'number') {
      duration = item.duration
    } else if ('metadata' in item) {
      const metadata = item.metadata as Record<string, unknown> | null
      if (typeof metadata?.duration === 'number') {
        duration = metadata.duration
      }
    }

    switch (item.type) {
      case 'link':
        return item.sourceUrl ? extractDomain(item.sourceUrl) : ''
      case 'note':
        return item.content?.slice(0, 50) || ''
      case 'image':
        return 'Image file'
      case 'voice':
        return duration > 0
          ? `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`
          : 'Voice memo'
      case 'clip':
        return 'Web clip'
      case 'pdf':
        return 'PDF document'
      case 'social':
        return 'Social post'
      default:
        return ''
    }
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--muted)]/30 border border-[var(--border)]/50">
      <div className="size-10 rounded-lg bg-[var(--muted)] flex items-center justify-center shrink-0">
        {item.type === 'link' ? (
          <Globe className="size-5 text-[var(--muted-foreground)]" aria-hidden="true" />
        ) : (
          <ItemTypeIcon type={item.type} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--foreground)] truncate">{item.title}</p>
        <p className="text-xs text-[var(--muted-foreground)] truncate">{getSubtitle()}</p>
      </div>
    </div>
  )
}

interface FilingPanelProps {
  isOpen: boolean
  item: FilingItem | null
  onClose: () => void
  onFile: (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]) => void
}

const FilingPanel = ({ isOpen, item, onClose, onFile }: FilingPanelProps): React.JSX.Element => {
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [linkedNotes, setLinkedNotes] = useState<LinkedNote[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Fetch real folders from vault
  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const paths = await window.api.notes.getFolders()
      // Add root folder option and convert paths to Folder objects
      const folders: Folder[] = [{ id: '', name: 'Notes (root)', path: '' }]
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
    enabled: isOpen // Only fetch when panel is open
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
    enabled: isOpen && !!item?.id,
    staleTime: 30000 // Cache for 30 seconds
  })

  // Convert AI suggestions to folder objects with confidence metadata
  const suggestedFolders = useMemo(() => {
    if (aiSuggestions.length > 0) {
      // Convert AI suggestions to Folder objects, keeping AI metadata
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 5)
        .map((s) => {
          const path = s.destination.path || ''
          return {
            id: path,
            name: path.split('/').pop() || path || 'Notes',
            path: path,
            // Store AI metadata for display
            aiConfidence: s.confidence,
            aiReason: s.reason
          } as Folder & { aiConfidence?: number; aiReason?: string }
        })
    }
    // Fallback to first 3 folders if no AI suggestions
    return vaultFolders.slice(0, 3)
  }, [aiSuggestions, vaultFolders])

  // Get suggested tags from AI
  const suggestedTags = useMemo(() => {
    if (aiSuggestions.length > 0) {
      // Collect unique tags from all suggestions
      const tagSet = new Set<string>()
      for (const suggestion of aiSuggestions) {
        for (const tag of suggestion.suggestedTags || []) {
          tagSet.add(tag)
        }
      }
      return Array.from(tagSet)
    }
    return []
  }, [aiSuggestions])

  // Get suggested folders for number shortcuts
  const suggestedFoldersForShortcut = useMemo(() => suggestedFolders, [suggestedFolders])

  // Load existing item tags when panel opens with new item
  useEffect(() => {
    if (isOpen && item) {
      setSelectedFolder(null)
      // Load existing tags from the item
      setTags(item.tags || [])
      setLinkedNotes([])
    }
  }, [isOpen, item?.id, item?.tags])

  // Auto-add suggested tags from AI when they load (if item has no tags)
  useEffect(() => {
    if (suggestedTags.length > 0 && tags.length === 0) {
      // Don't auto-add, but we'll show them as suggestions in TagAutocomplete
    }
  }, [suggestedTags, tags.length])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      // Skip if typing in an input field
      if (isInputFocused()) return

      // Cmd/Ctrl + Enter to file
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (selectedFolder && item) {
          handleFileItem()
        }
        return
      }

      // Number keys 1-5 to select suggested folders (when not in input)
      if (/^[1-5]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1
        if (index < suggestedFoldersForShortcut.length) {
          e.preventDefault()
          setSelectedFolder(suggestedFoldersForShortcut[index])
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedFolder, item, suggestedFoldersForShortcut])

  const handleFolderSelect = useCallback((folder: Folder): void => {
    setSelectedFolder(folder)
  }, [])

  const handleTagsChange = useCallback((newTags: string[]): void => {
    setTags(newTags)
  }, [])

  const handleLinkedNotesChange = useCallback((notes: LinkedNote[]): void => {
    setLinkedNotes(notes)
  }, [])

  const handleFileItem = async (): Promise<void> => {
    if (!selectedFolder || !item) return

    setIsLoading(true)

    // Simulate a brief delay for filing
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Track suggestion feedback if AI suggestions were available
    if (aiSuggestions.length > 0) {
      const topSuggestion = aiSuggestions[0]
      const suggestedPath = topSuggestion?.destination?.path || ''

      // Track the suggestion feedback asynchronously (don't block filing)
      window.api.inbox
        .trackSuggestion({
          itemId: item.id,
          itemType: item.type,
          suggestedTo: suggestedPath,
          actualTo: selectedFolder.id,
          confidence: topSuggestion?.confidence || 0,
          suggestedTags: topSuggestion?.suggestedTags || [],
          actualTags: tags
        })
        .catch((error) => {
          console.error('Failed to track suggestion:', error)
        })
    }

    onFile(
      item.id,
      selectedFolder.id,
      tags,
      linkedNotes.map((n) => n.id)
    )

    setIsLoading(false)
    onClose()
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      onClose()
    }
  }

  const modifierKeyDisplay = isMac ? '⌘' : 'Ctrl+'
  const keyboardHint = `${modifierKeyDisplay}⏎ file · 1-5 folder · Esc close`

  const canFile = selectedFolder !== null && !isLoading

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b border-[var(--border)] shrink-0">
          <SheetTitle className="text-lg font-semibold">File Item</SheetTitle>
        </SheetHeader>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Item Preview */}
          {item && <ItemPreview item={item} />}

          <Separator />

          {/* AI Suggestions Indicator */}
          {isLoadingAISuggestions && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading AI suggestions...</span>
            </div>
          )}

          {aiSuggestions.length > 0 && !isLoadingAISuggestions && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Sparkles className="size-4 text-yellow-500" />
              <span>AI-powered suggestions available</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="size-4 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs">
                    <p>
                      Suggestions are based on content similarity with your existing notes and
                      filing patterns.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {/* Folder Selection */}
          <FolderSelector
            folders={vaultFolders}
            suggestedFolders={suggestedFolders}
            recentFolders={[]} // TODO: Track recent folders in filing history
            selectedFolder={selectedFolder}
            onSelect={handleFolderSelect}
          />

          <Separator />

          {/* Tags */}
          <TagAutocomplete tags={tags} onTagsChange={handleTagsChange} showSections={true} />

          <Separator />

          {/* Link to Notes */}
          <LinkSearch linkedNotes={linkedNotes} onLinkedNotesChange={handleLinkedNotesChange} />
        </div>

        {/* Footer */}
        <SheetFooter className="px-6 py-4 border-t border-[var(--border)] shrink-0 flex-col gap-3">
          <Button onClick={handleFileItem} disabled={!canFile} className="w-full" size="lg">
            {isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" aria-hidden="true" />
                Filing...
              </>
            ) : (
              <>
                {canFile && <Check className="size-4 mr-2" aria-hidden="true" />}
                File item
              </>
            )}
          </Button>
          <p className="text-xs text-[var(--muted-foreground)] text-center">{keyboardHint}</p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export { FilingPanel }
