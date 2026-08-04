/**
 * Move to Folder Dialog
 *
 * Modal dialog for moving notes to a different folder.
 * Features:
 * - AI-powered folder suggestions
 * - Search/filter folders
 * - Create new folder option
 * - Keyboard navigation (arrows, enter, escape, number keys)
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Folder, Plus, Sparkles, Search } from '@/lib/icons'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { cn } from '@/lib/utils'
import { notesService } from '@/services/notes-service'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

interface FolderItem {
  path: string
  displayName: string
  /** Custom folder icon (raw emoji or "icon:Name"); falls back to the default glyph */
  icon?: string | null
  isRoot?: boolean
  isSuggestion?: boolean
  confidence?: number
  reason?: string
}

interface MoveToFolderDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback when dialog should close */
  onOpenChange: (open: boolean) => void
  /** Note ID(s) to move - first one is used for AI suggestions */
  noteIds: string[]
  /** Current folder of the note(s) - to disable in list */
  currentFolder?: string
  /** Callback when move is confirmed */
  onMove: (targetFolder: string) => void
  /** Optional: Note title for display (single note) */
  noteTitle?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Highlight matching text in a string
 */
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) return text

  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-yellow-200 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  )
}

// ============================================================================
// Component
// ============================================================================

export function MoveToFolderDialog({
  open,
  onOpenChange,
  noteIds,
  currentFolder = '',
  onMove,
  noteTitle
}: MoveToFolderDialogProps): React.JSX.Element {
  const sessionKey = `${noteIds.join(',')}:${currentFolder}:${noteTitle ?? ''}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <MoveToFolderDialogSession
          key={sessionKey}
          noteIds={noteIds}
          currentFolder={currentFolder}
          onMove={onMove}
          onOpenChange={onOpenChange}
          noteTitle={noteTitle}
        />
      ) : null}
    </Dialog>
  )
}

interface MoveToFolderDialogSessionProps {
  onOpenChange: (open: boolean) => void
  noteIds: string[]
  currentFolder: string
  onMove: (targetFolder: string) => void
  noteTitle?: string
}

function MoveToFolderDialogSession({
  onOpenChange,
  noteIds,
  currentFolder,
  onMove,
  noteTitle
}: MoveToFolderDialogSessionProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  // State
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isMoving, setIsMoving] = useState(false)
  const { enabled: aiEnabled } = useAISettingsContext()

  // Refs
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch all folders
  const { data: allFolders = [], isLoading: isLoadingFolders } = useQuery({
    queryKey: ['notes', 'folders'],
    queryFn: () => notesService.getFolders(),
    enabled: true
  })

  // Fetch AI suggestions for the first selected note
  const { data: suggestionsData, isLoading: isLoadingSuggestions } = useQuery({
    queryKey: ['folderView', 'folder-suggestions', noteIds[0]],
    queryFn: async () => {
      if (!noteIds[0]) return { suggestions: [] }
      return window.api.folderView.getFolderSuggestions(noteIds[0])
    },
    enabled: aiEnabled && noteIds.length > 0
  })

  const suggestions = useMemo(
    () => (aiEnabled ? (suggestionsData?.suggestions ?? []) : []),
    [aiEnabled, suggestionsData]
  )

  // Build folder items list
  const folderItems = useMemo((): FolderItem[] => {
    const items: FolderItem[] = []
    const query = searchQuery.toLowerCase()
    const iconByPath = new Map(allFolders.map((f) => [f.path, f.icon ?? null]))

    // Add AI suggestions section (if not searching)
    if (!searchQuery && suggestions.length > 0) {
      suggestions.forEach((s) => {
        // Skip if it's the current folder
        if (s.path === currentFolder) return

        items.push({
          path: s.path,
          displayName: s.path || 'Notes (root)',
          icon: iconByPath.get(s.path) ?? null,
          isSuggestion: true,
          confidence: s.confidence,
          reason: s.reason
        })
      })
    }

    // Add all folders section
    // Always include root
    const rootItem: FolderItem = {
      path: '',
      displayName: 'Notes (root)',
      isRoot: true
    }

    // Filter and add folders
    const filteredFolders = allFolders
      .map((f) => f.path)
      .filter((path) => {
        if (query && !path.toLowerCase().includes(query)) return false
        return true
      })
      .sort()

    // Build the "All Folders" list
    const allFolderItems: FolderItem[] = []

    // Add root if it matches search or no search
    if (!query || 'notes (root)'.includes(query) || 'root'.includes(query)) {
      // Don't add root if it's already in suggestions and we're not searching
      const rootInSuggestions = !searchQuery && suggestions.some((s) => s.path === '')
      if (!rootInSuggestions) {
        allFolderItems.push(rootItem)
      }
    }

    // Add other folders
    filteredFolders.forEach((path) => {
      // Skip if already in suggestions (when not searching)
      if (!searchQuery && suggestions.some((s) => s.path === path)) return

      allFolderItems.push({
        path,
        displayName: path,
        icon: iconByPath.get(path) ?? null
      })
    })

    return [...items, ...allFolderItems]
  }, [allFolders, suggestions, searchQuery, currentFolder])

  // Check if search query could be a new folder
  const canCreateFolder = useMemo(() => {
    if (!searchQuery.trim()) return false
    // Check if the exact folder already exists
    const exists = allFolders.some((f) => f.path.toLowerCase() === searchQuery.toLowerCase())
    return !exists
  }, [searchQuery, allFolders])

  // Get the selected folder item
  const selectedItem = folderItems[selectedIndex]

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.querySelector('[data-selected="true"]')
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Handle move action
  const handleMove = useCallback(
    async (targetFolder: string): Promise<void> => {
      if (targetFolder === currentFolder) return

      setIsMoving(true)
      try {
        onMove(targetFolder)
        onOpenChange(false)
      } finally {
        setIsMoving(false)
      }
    },
    [currentFolder, onMove, onOpenChange]
  )

  // Handle create folder and move
  const handleCreateAndMove = useCallback(async (): Promise<void> => {
    if (!canCreateFolder) return

    setIsMoving(true)
    try {
      // Create the folder first
      const result = await notesService.createFolder(searchQuery.trim())
      if (result.success) {
        onMove(searchQuery.trim())
        onOpenChange(false)
      }
    } finally {
      setIsMoving(false)
    }
  }, [canCreateFolder, searchQuery, onMove, onOpenChange])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      const itemCount = folderItems.length + (canCreateFolder ? 1 : 0)

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % itemCount)
          break

        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + itemCount) % itemCount)
          break

        case 'Enter':
          e.preventDefault()
          if (canCreateFolder && selectedIndex === folderItems.length) {
            // Create new folder and move
            void handleCreateAndMove()
          } else if (selectedItem && selectedItem.path !== currentFolder) {
            void handleMove(selectedItem.path)
          }
          break

        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break

        // Number keys for quick selection (1-5 for suggestions)
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
          if (!searchQuery) {
            const num = parseInt(e.key, 10) - 1
            if (num < folderItems.length && folderItems[num].isSuggestion) {
              e.preventDefault()
              void handleMove(folderItems[num].path)
            }
          }
          break
      }
    },
    [
      folderItems,
      canCreateFolder,
      selectedIndex,
      selectedItem,
      currentFolder,
      onOpenChange,
      searchQuery,
      handleCreateAndMove,
      handleMove
    ]
  )

  // Dialog title
  const title =
    noteIds.length === 1
      ? noteTitle
        ? `Move "${noteTitle}"`
        : 'Move to Folder'
      : `Move ${noteIds.length} Notes`

  const isLoading = isLoadingFolders || (aiEnabled && isLoadingSuggestions)

  return (
    <DialogContent className="sm:max-w-md" onKeyDown={handleKeyDown}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>

      {/* Search Input */}
      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus
          placeholder={tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.searchFolders')}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value)
            setSelectedIndex(0)
          }}
          className="ps-9"
        />
      </div>

      {/* Folder List */}
      <ScrollArea className="h-[300px] -mx-2">
        <div ref={listRef} className="px-2 space-y-1">
          {isLoading ? (
            <div className="flex items-center justify-center h-20 text-muted-foreground">
              {tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.loadingFolders')}
            </div>
          ) : (
            <>
              {/* AI Suggestions Section */}
              {!searchQuery && suggestions.length > 0 && (
                <div className="mb-2">
                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                    <Sparkles className="h-3 w-3" />

                    {tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.suggested')}
                  </div>
                  {folderItems
                    .filter((item) => item.isSuggestion)
                    .map((item, index) => {
                      const isSelected = selectedIndex === index
                      const isCurrent = item.path === currentFolder

                      return (
                        <button
                          key={`suggestion-${item.path}`}
                          type="button"
                          data-selected={isSelected}
                          disabled={isCurrent}
                          onClick={() => void (!isCurrent && handleMove(item.path))}
                          className={cn(
                            'w-full flex items-center gap-2 px-2 py-2 rounded-md text-start',
                            'transition-colors',
                            isSelected && !isCurrent && 'bg-accent',
                            isCurrent && 'opacity-50 cursor-not-allowed',
                            !isSelected && !isCurrent && 'hover:bg-muted/50'
                          )}
                        >
                          <span className="text-xs text-muted-foreground w-4 text-center">
                            {index + 1}
                          </span>
                          {item.icon ? (
                            <NoteIconDisplay
                              value={item.icon}
                              className="h-4 w-4 flex-shrink-0 text-center text-[15px] leading-none"
                            />
                          ) : (
                            <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <span className="flex-1 truncate">{item.displayName}</span>
                          {item.confidence && item.confidence > 0.7 && (
                            <span className="text-xs text-amber-500">
                              {tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.bestMatch')}
                            </span>
                          )}
                          {isCurrent && (
                            <span className="text-xs text-muted-foreground">
                              {tPhaseF(
                                'phaseF.componentsFolderViewMoveToFolderDialog.currentFolderBadge'
                              )}
                            </span>
                          )}
                        </button>
                      )
                    })}
                </div>
              )}

              {/* All Folders Section */}
              <div>
                {!searchQuery && (
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.allFolders')}
                  </div>
                )}
                {folderItems
                  .filter((item) => !item.isSuggestion)
                  .map((item) => {
                    const actualIndex = folderItems.indexOf(item)
                    const isSelected = selectedIndex === actualIndex
                    const isCurrent = item.path === currentFolder

                    return (
                      <button
                        key={`folder-${item.path}`}
                        type="button"
                        data-selected={isSelected}
                        disabled={isCurrent}
                        onClick={() => void (!isCurrent && handleMove(item.path))}
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-2 rounded-md text-start',
                          'transition-colors',
                          isSelected && !isCurrent && 'bg-accent',
                          isCurrent && 'opacity-50 cursor-not-allowed',
                          !isSelected && !isCurrent && 'hover:bg-muted/50'
                        )}
                      >
                        {item.icon ? (
                          <NoteIconDisplay
                            value={item.icon}
                            className="h-4 w-4 flex-shrink-0 text-center text-[15px] leading-none"
                          />
                        ) : (
                          <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        )}
                        <span className="flex-1 truncate">
                          {searchQuery
                            ? highlightMatch(item.displayName, searchQuery)
                            : item.displayName}
                        </span>
                        {isCurrent && (
                          <span className="text-xs text-muted-foreground">
                            {tPhaseF(
                              'phaseF.componentsFolderViewMoveToFolderDialog.currentFolderBadge'
                            )}
                          </span>
                        )}
                      </button>
                    )
                  })}

                {/* Empty state */}
                {folderItems.filter((item) => !item.isSuggestion).length === 0 &&
                  !canCreateFolder && (
                    <div className="flex items-center justify-center h-20 text-muted-foreground text-sm">
                      {tPhaseF(
                        'phaseF.componentsFolderViewMoveToFolderDialog.noFoldersMatchQuery',
                        { query: searchQuery }
                      )}
                    </div>
                  )}
              </div>

              {/* Create New Folder Option */}
              {canCreateFolder && (
                <div className="border-t pt-2 mt-2">
                  <button
                    type="button"
                    data-selected={selectedIndex === folderItems.length}
                    onClick={() => void handleCreateAndMove()}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-2 rounded-md text-start',
                      'transition-colors text-primary',
                      selectedIndex === folderItems.length && 'bg-accent',
                      selectedIndex !== folderItems.length && 'hover:bg-muted/50'
                    )}
                  >
                    <Plus className="h-4 w-4 flex-shrink-0" />
                    <span className="flex-1 truncate">
                      {tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.createFolderNamed', {
                        name: searchQuery.trim()
                      })}
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMoving}>
          {tPhaseF('phaseF.componentsFolderViewMoveToFolderDialog.cancel')}
        </Button>
        <Button
          onClick={() => {
            if (canCreateFolder && selectedIndex === folderItems.length) {
              void handleCreateAndMove()
            } else if (selectedItem && selectedItem.path !== currentFolder) {
              void handleMove(selectedItem.path)
            }
          }}
          disabled={
            isMoving || (!canCreateFolder && (!selectedItem || selectedItem.path === currentFolder))
          }
        >
          {isMoving ? 'Moving...' : 'Move'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export default MoveToFolderDialog
