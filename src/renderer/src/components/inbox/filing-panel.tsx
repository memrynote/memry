/**
 * Filing Panel Component
 *
 * A slide-over panel for filing items to folders with:
 * - Item preview (single or bulk)
 * - AI folder suggestions
 * - Folder tree navigation
 * - Tag management
 * - File action
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import {
  Sparkles,
  FolderInput,
  Tag as TagIcon,
  Check,
  X,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { TypeIcon } from './type-badge'
import { FolderTree } from './folder-tree'
import { TagInput } from './tag-input'
import type { InboxItem, InboxItemType } from '@/data/inbox-types'
import type {
  Folder,
  Tag,
  FolderSuggestion,
  AISuggestions,
  TagColor,
} from '@/data/filing-types'
import { AI_CONFIDENCE_THRESHOLDS } from '@/data/filing-types'

// ============================================================================
// TYPES
// ============================================================================

export interface FilingPanelProps {
  /** Whether the panel is open */
  isOpen: boolean
  /** Callback to close the panel */
  onClose: () => void
  /** Items to file (1 or more for bulk filing) */
  items: InboxItem[]
  /** All available folders */
  folders: Folder[]
  /** All available tags */
  tags: Tag[]
  /** Recently used folder IDs */
  recentFolderIds?: string[]
  /** AI-generated suggestions */
  aiSuggestions?: AISuggestions
  /** Callback when items are filed */
  onFile: (folderId: string, tagIds: string[]) => void
  /** Callback to create a new tag */
  onCreateTag?: (name: string, color: TagColor) => Tag
  /** Whether filing is in progress */
  isLoading?: boolean
}

// ============================================================================
// ITEM PREVIEW
// ============================================================================

interface ItemPreviewProps {
  items: InboxItem[]
}

function ItemPreview({ items }: ItemPreviewProps): React.JSX.Element {
  if (items.length === 1) {
    const item = items[0]
    return (
      <div className="flex items-start gap-3 rounded-lg bg-accent/30 p-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background shadow-sm">
          <TypeIcon type={item.type} size="md" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground">{item.title}</p>
          {item.type === 'link' && 'domain' in item && (
            <p className="truncate text-sm text-muted-foreground">
              {(item as InboxItem & { domain: string }).domain}
            </p>
          )}
        </div>
      </div>
    )
  }

  // Bulk filing preview
  const typeCounts = items.reduce(
    (acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1
      return acc
    },
    {} as Record<InboxItemType, number>
  )

  const typeLabels = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
    .join(', ')

  return (
    <div className="flex items-center gap-3 rounded-lg bg-accent/30 p-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <FolderInput className="size-5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          Filing {items.length} items
        </p>
        <p className="truncate text-sm text-muted-foreground">{typeLabels}</p>
      </div>
    </div>
  )
}

// ============================================================================
// AI SUGGESTION CARD
// ============================================================================

interface AISuggestionCardProps {
  suggestion: FolderSuggestion
  folder: Folder | undefined
  variant: 'high' | 'medium'
  onAccept: () => void
  onChooseDifferent?: () => void
  allItems?: InboxItem[]
}

function AISuggestionCard({
  suggestion,
  folder,
  variant,
  onAccept,
  onChooseDifferent,
  allItems = [],
}: AISuggestionCardProps): React.JSX.Element | null {
  if (!folder) return null

  const isHighConfidence = variant === 'high'

  // Get similar item titles
  const similarItems = suggestion.similarItemIds
    .map((id) => allItems.find((item) => item.id === id))
    .filter(Boolean)
    .slice(0, 3)

  return (
    <div
      className={cn(
        'rounded-xl p-4',
        isHighConfidence
          ? 'bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border border-amber-200/50 dark:border-amber-800/50'
          : 'bg-accent/40 border border-border/50'
      )}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex size-7 items-center justify-center rounded-lg',
              isHighConfidence
                ? 'bg-amber-100 dark:bg-amber-900/50'
                : 'bg-accent'
            )}
          >
            <Sparkles
              className={cn(
                'size-4',
                isHighConfidence
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
            />
          </div>
          <span
            className={cn(
              'text-sm font-medium',
              isHighConfidence
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-foreground'
            )}
          >
            {isHighConfidence ? 'AI Suggestion' : 'Possible destination'}
          </span>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
            isHighConfidence
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'
              : 'bg-accent text-muted-foreground'
          )}
        >
          {suggestion.confidence}%
        </span>
      </div>

      {/* Folder path */}
      <div className="mb-3 flex items-center gap-2 rounded-lg bg-background/60 p-2">
        <FolderInput className="size-4 text-primary" />
        <span className="text-sm font-medium">{folder.path}</span>
      </div>

      {/* Reason / similar items */}
      {similarItems.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Similar items here:
          </p>
          <ul className="space-y-1">
            {similarItems.map((item) => (
              <li
                key={item!.id}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <span className="text-muted-foreground/60">•</span>
                <span className="truncate">{item!.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {isHighConfidence ? (
          <>
            <Button
              variant="default"
              size="sm"
              onClick={onAccept}
              className={cn(
                'flex-1 gap-1.5',
                'bg-amber-500 hover:bg-amber-600 text-white'
              )}
            >
              <Check className="size-4" />
              Accept
            </Button>
            {onChooseDifferent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onChooseDifferent}
                className="text-muted-foreground"
              >
                Choose Different
              </Button>
            )}
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={onAccept}
            className="w-full"
          >
            File here
          </Button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// SELECTED FOLDER DISPLAY
// ============================================================================

interface SelectedFolderProps {
  folder: Folder
  onClear: () => void
}

function SelectedFolder({ folder, onClear }: SelectedFolderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
      <FolderInput className="size-4 text-primary" />
      <span className="flex-1 text-sm font-medium">{folder.path}</span>
      <button
        type="button"
        onClick={onClear}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function FilingPanel({
  isOpen,
  onClose,
  items,
  folders,
  tags,
  recentFolderIds = [],
  aiSuggestions,
  onFile,
  onCreateTag,
  isLoading = false,
}: FilingPanelProps): React.JSX.Element {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [showFolderPicker, setShowFolderPicker] = useState(true)

  // Get folder map
  const folderMap = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders]
  )

  // Get selected folder
  const selectedFolder = selectedFolderId
    ? folderMap.get(selectedFolderId)
    : undefined

  // Get suggestion folder IDs
  const suggestedFolderIds = useMemo(() => {
    if (!aiSuggestions) return []
    const ids: string[] = []
    if (aiSuggestions.primary) ids.push(aiSuggestions.primary.folderId)
    aiSuggestions.alternatives.forEach((alt) => ids.push(alt.folderId))
    return ids
  }, [aiSuggestions])

  // Get high confidence suggestion
  const highConfidenceSuggestion = useMemo(() => {
    if (
      aiSuggestions?.primary &&
      aiSuggestions.primary.confidence >= AI_CONFIDENCE_THRESHOLDS.HIGH
    ) {
      return aiSuggestions.primary
    }
    return null
  }, [aiSuggestions])

  // Get medium confidence suggestions
  const mediumConfidenceSuggestions = useMemo(() => {
    if (!aiSuggestions) return []
    const suggestions: FolderSuggestion[] = []

    if (
      aiSuggestions.primary &&
      aiSuggestions.primary.confidence >= AI_CONFIDENCE_THRESHOLDS.MEDIUM &&
      aiSuggestions.primary.confidence < AI_CONFIDENCE_THRESHOLDS.HIGH
    ) {
      suggestions.push(aiSuggestions.primary)
    }

    aiSuggestions.alternatives.forEach((alt) => {
      if (alt.confidence >= AI_CONFIDENCE_THRESHOLDS.MEDIUM) {
        suggestions.push(alt)
      }
    })

    return suggestions.slice(0, 2)
  }, [aiSuggestions])

  // Initialize tags from items
  useEffect(() => {
    if (isOpen && items.length > 0) {
      // Get common tags across all items
      const tagCounts = new Map<string, number>()
      items.forEach((item) => {
        item.tagIds.forEach((tagId) => {
          tagCounts.set(tagId, (tagCounts.get(tagId) || 0) + 1)
        })
      })

      // Only include tags present on all items
      const commonTagIds = Array.from(tagCounts.entries())
        .filter(([, count]) => count === items.length)
        .map(([tagId]) => tagId)

      setSelectedTagIds(commonTagIds)
    }
  }, [isOpen, items])

  // Reset state when closing
  useEffect(() => {
    if (!isOpen) {
      setSelectedFolderId(null)
      setSelectedTagIds([])
      setShowFolderPicker(true)
    }
  }, [isOpen])

  // Handle accept suggestion
  const handleAcceptSuggestion = useCallback((folderId: string) => {
    setSelectedFolderId(folderId)
    setShowFolderPicker(false)
  }, [])

  // Handle file action
  const handleFile = useCallback(() => {
    if (selectedFolderId) {
      onFile(selectedFolderId, selectedTagIds)
    }
  }, [selectedFolderId, selectedTagIds, onFile])

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (selectedFolderId) {
          handleFile()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, selectedFolderId, handleFile])

  const canFile = selectedFolderId !== null && !isLoading

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-md"
      >
        {/* Header */}
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-2">
            <FolderInput className="size-5 text-primary" />
            File {items.length === 1 ? 'Item' : `${items.length} Items`}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Choose a folder and tags for the selected items
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable content */}
        <ScrollArea className="flex-1">
          <div className="space-y-6 p-6">
            {/* Item Preview */}
            <section>
              <ItemPreview items={items} />
            </section>

            {/* AI Suggestion - High Confidence */}
            {highConfidenceSuggestion && !selectedFolderId && (
              <section>
                <AISuggestionCard
                  suggestion={highConfidenceSuggestion}
                  folder={folderMap.get(highConfidenceSuggestion.folderId)}
                  variant="high"
                  onAccept={() =>
                    handleAcceptSuggestion(highConfidenceSuggestion.folderId)
                  }
                  onChooseDifferent={() => setShowFolderPicker(true)}
                  allItems={items}
                />
              </section>
            )}

            {/* AI Suggestions - Medium Confidence */}
            {!highConfidenceSuggestion &&
              mediumConfidenceSuggestions.length > 0 &&
              !selectedFolderId && (
                <section>
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="size-3" />
                    Possible destinations
                  </h3>
                  <div className="space-y-2">
                    {mediumConfidenceSuggestions.map((suggestion) => (
                      <AISuggestionCard
                        key={suggestion.folderId}
                        suggestion={suggestion}
                        folder={folderMap.get(suggestion.folderId)}
                        variant="medium"
                        onAccept={() =>
                          handleAcceptSuggestion(suggestion.folderId)
                        }
                        allItems={items}
                      />
                    ))}
                  </div>
                </section>
              )}

            <Separator />

            {/* Selected Folder */}
            {selectedFolder && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Filing to
                </h3>
                <SelectedFolder
                  folder={selectedFolder}
                  onClear={() => {
                    setSelectedFolderId(null)
                    setShowFolderPicker(true)
                  }}
                />
              </section>
            )}

            {/* Folder Selection */}
            {showFolderPicker && (
              <section>
                <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <FolderInput className="size-3" />
                  Choose folder
                </h3>
                <FolderTree
                  folders={folders}
                  selectedId={selectedFolderId}
                  recentIds={recentFolderIds}
                  suggestedIds={suggestedFolderIds}
                  onSelect={(id) => {
                    setSelectedFolderId(id)
                  }}
                  className="h-[280px]"
                />
              </section>
            )}

            <Separator />

            {/* Tags */}
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <TagIcon className="size-3" />
                Tags
              </h3>
              <TagInput
                allTags={tags}
                selectedTagIds={selectedTagIds}
                onTagsChange={setSelectedTagIds}
                onCreateTag={onCreateTag}
                placeholder="Add tags..."
              />
            </section>
          </div>
        </ScrollArea>

        {/* Footer */}
        <SheetFooter className="border-t px-6 py-4">
          <div className="flex w-full items-center gap-3">
            <Button variant="ghost" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={handleFile}
              disabled={!canFile}
              className="flex-1 gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Filing...
                </>
              ) : (
                <>
                  <Check className="size-4" />
                  {selectedFolder
                    ? `File to ${selectedFolder.name}`
                    : 'Select a folder'}
                </>
              )}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
