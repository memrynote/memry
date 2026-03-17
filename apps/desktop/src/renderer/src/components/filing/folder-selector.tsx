import { useState, useMemo } from 'react'
import { Search, Folder, Check, ChevronRight, ChevronDown, Plus, Sparkles } from '@/lib/icons'

import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Folder as FolderType } from '@/types'

// Extended folder type with AI metadata
interface AIFolderType extends FolderType {
  aiConfidence?: number
  aiReason?: string
}

interface FolderItemProps {
  folder: AIFolderType
  isSelected: boolean
  onSelect: (folder: FolderType) => void
}

const FolderItem = ({ folder, isSelected, onSelect }: FolderItemProps): React.JSX.Element => {
  const handleClick = (): void => {
    onSelect(folder)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(folder)
    }
  }

  const hasAISuggestion = folder.aiConfidence !== undefined && folder.aiConfidence > 0

  const content = (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer',
        'transition-all duration-[var(--duration-instant)] ease-[var(--ease-out)]',
        isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
      )}
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <Folder className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-sm truncate">{folder.path || 'Notes'}</span>
      {hasAISuggestion && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Sparkles className="size-3 text-yellow-500" aria-hidden="true" />
          <span>{Math.round(folder.aiConfidence! * 100)}%</span>
        </span>
      )}
      {isSelected && (
        <Check
          className={cn(
            'size-4 shrink-0',
            'animate-in zoom-in-75 duration-[var(--duration-fast)]',
            'motion-reduce:animate-none'
          )}
          aria-hidden="true"
        />
      )}
    </div>
  )

  // Wrap with tooltip if AI suggestion has a reason
  if (hasAISuggestion && folder.aiReason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            <p className="text-sm">{folder.aiReason}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return content
}

interface FolderSectionProps {
  title: string
  folders: AIFolderType[]
  selectedId: string | null
  onSelect: (folder: FolderType) => void
}

const FolderSection = ({
  title,
  folders,
  selectedId,
  onSelect
}: FolderSectionProps): React.JSX.Element | null => {
  if (folders.length === 0) return null

  return (
    <div className="space-y-1">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1">
        {title}
      </h4>
      <div className="space-y-0.5" role="listbox" aria-label={title}>
        {folders.map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            isSelected={selectedId === folder.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

interface FolderSelectorProps {
  folders: FolderType[]
  suggestedFolders: AIFolderType[]
  recentFolders: AIFolderType[]
  selectedFolder: FolderType | null
  onSelect: (folder: FolderType) => void
}

const FolderSelector = ({
  folders,
  suggestedFolders,
  recentFolders,
  selectedFolder,
  onSelect
}: FolderSelectorProps): React.JSX.Element => {
  const [searchQuery, setSearchQuery] = useState('')
  const [isAllExpanded, setIsAllExpanded] = useState(false)

  // Filter folders based on search query
  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders
    const query = searchQuery.toLowerCase()
    return folders.filter(
      (folder) =>
        folder.name.toLowerCase().includes(query) || folder.path.toLowerCase().includes(query)
    )
  }, [folders, searchQuery])

  // When searching, show filtered results; otherwise show sections
  const isSearching = searchQuery.trim().length > 0

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearchQuery(e.target.value)
  }

  const handleToggleAll = (): void => {
    setIsAllExpanded((prev) => !prev)
  }

  return (
    <div className="space-y-4">
      {/* Section Label */}
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-medium text-foreground">Choose folder</h3>
        <span className="text-red-500">*</span>
      </div>

      {/* Selected folder display */}
      {selectedFolder && (
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-md',
            'bg-primary/10 border border-primary/20',
            'animate-in fade-in-0 duration-[var(--duration-fast)]',
            'motion-reduce:animate-none'
          )}
        >
          <Folder className="size-4 text-primary" aria-hidden="true" />
          <span className="text-sm font-medium text-primary">{selectedFolder.path}</span>
          <Check className="size-4 text-primary ml-auto" aria-hidden="true" />
        </div>
      )}

      {/* Search Input */}
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="text"
          placeholder="Search folders..."
          value={searchQuery}
          onChange={handleSearchChange}
          className="pl-9"
          aria-label="Search folders"
        />
      </div>

      {/* Folder Sections */}
      <div className="space-y-4 max-h-[280px] overflow-y-auto">
        {isSearching ? (
          // Search Results
          <div className="space-y-0.5" role="listbox" aria-label="Search results">
            {filteredFolders.length > 0
              ? filteredFolders.map((folder) => (
                  <FolderItem
                    key={folder.id}
                    folder={folder}
                    isSelected={selectedFolder?.id === folder.id}
                    onSelect={onSelect}
                  />
                ))
              : null}

            {/* Show "Create new folder" option when searching */}
            {searchQuery.trim() && (
              <div
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer',
                  'transition-all duration-[var(--duration-instant)] ease-[var(--ease-out)]',
                  selectedFolder?.path === searchQuery.trim()
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted border border-dashed border-muted-foreground/30'
                )}
                role="option"
                aria-selected={selectedFolder?.path === searchQuery.trim()}
                tabIndex={0}
                onClick={() => {
                  const newFolder: FolderType = {
                    id: searchQuery.trim(),
                    name: searchQuery.trim().split('/').pop() || searchQuery.trim(),
                    path: searchQuery.trim()
                  }
                  onSelect(newFolder)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    const newFolder: FolderType = {
                      id: searchQuery.trim(),
                      name: searchQuery.trim().split('/').pop() || searchQuery.trim(),
                      path: searchQuery.trim()
                    }
                    onSelect(newFolder)
                  }
                }}
              >
                <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 text-sm">
                  Create "<span className="font-medium">{searchQuery.trim()}</span>"
                </span>
                {selectedFolder?.path === searchQuery.trim() && (
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Suggested Folders */}
            <FolderSection
              title="Suggested"
              folders={suggestedFolders}
              selectedId={selectedFolder?.id || null}
              onSelect={onSelect}
            />

            {/* Recent Folders */}
            <FolderSection
              title="Recent"
              folders={recentFolders}
              selectedId={selectedFolder?.id || null}
              onSelect={onSelect}
            />

            {/* All Folders (Collapsible) */}
            <div className="space-y-1">
              <button
                type="button"
                onClick={handleToggleAll}
                className={cn(
                  'flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1',
                  'text-muted-foreground/70 hover:text-muted-foreground',
                  'transition-colors duration-[var(--duration-instant)]'
                )}
                aria-expanded={isAllExpanded}
              >
                {isAllExpanded ? (
                  <ChevronDown className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-3" aria-hidden="true" />
                )}
                All folders
              </button>
              {isAllExpanded && (
                <div className="space-y-0.5" role="listbox" aria-label="All folders">
                  {folders.map((folder) => (
                    <FolderItem
                      key={folder.id}
                      folder={folder}
                      isSelected={selectedFolder?.id === folder.id}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export { FolderSelector }
