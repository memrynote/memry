import { useMemo } from 'react'
import { Folder } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Folder as FolderType } from '@/types'

// Highlight matching text in folder name
const HighlightedText = ({
  text,
  query,
  isRowHighlighted
}: {
  text: string
  query: string
  isRowHighlighted: boolean
}): React.JSX.Element => {
  if (!query.trim()) {
    return <>{text}</>
  }

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) {
    return <>{text}</>
  }

  const before = text.slice(0, index)
  const match = text.slice(index, index + query.length)
  const after = text.slice(index + query.length)

  return (
    <>
      {before}
      <span
        className={cn(
          'font-semibold',
          isRowHighlighted ? 'text-[var(--primary-foreground)]' : 'text-[var(--foreground)]'
        )}
      >
        {match}
      </span>
      {after}
    </>
  )
}

interface QuickFileDropdownItemProps {
  folder: FolderType
  query: string
  isHighlighted: boolean
  onSelect: (folder: FolderType) => void
}

const QuickFileDropdownItem = ({
  folder,
  query,
  isHighlighted,
  onSelect
}: QuickFileDropdownItemProps): React.JSX.Element => {
  const handleClick = (): void => {
    onSelect(folder)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 cursor-pointer',
        'dropdown-highlight', // smooth background transition
        isHighlighted ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
      )}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      tabIndex={0}
      role="option"
      aria-selected={isHighlighted}
    >
      <Folder
        className={cn(
          'size-4 shrink-0',
          isHighlighted ? 'text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)]'
        )}
        aria-hidden="true"
      />
      <span className="text-sm truncate">
        <HighlightedText text={folder.path} query={query} isRowHighlighted={isHighlighted} />
      </span>
    </div>
  )
}

interface QuickFileDropdownProps {
  folders: FolderType[]
  query: string
  highlightedIndex: number
  onSelect: (folder: FolderType) => void
  maxResults?: number
}

const QuickFileDropdown = ({
  folders,
  query,
  highlightedIndex,
  onSelect,
  maxResults = 5
}: QuickFileDropdownProps): React.JSX.Element | null => {
  // Filter folders based on query
  const filteredFolders = useMemo(() => {
    if (!query.trim()) return []

    const lowerQuery = query.toLowerCase()
    return folders
      .filter(
        (folder) =>
          folder.name.toLowerCase().includes(lowerQuery) ||
          folder.path.toLowerCase().includes(lowerQuery)
      )
      .slice(0, maxResults)
  }, [folders, query, maxResults])

  // Don't render if no query
  if (!query.trim()) {
    return null
  }

  return (
    <div
      className={cn(
        'absolute top-full left-0 right-0 mt-1 bg-background border border-border rounded-md shadow-lg z-20 overflow-hidden',
        'animate-in fade-in-0 slide-in-from-top-2 duration-[var(--duration-fast)]'
      )}
      role="listbox"
      aria-label="Folder suggestions"
    >
      {filteredFolders.length > 0 ? (
        filteredFolders.map((folder, index) => (
          <QuickFileDropdownItem
            key={folder.id}
            folder={folder}
            query={query}
            isHighlighted={index === highlightedIndex}
            onSelect={onSelect}
          />
        ))
      ) : (
        <div className="px-3 py-3 text-sm text-[var(--muted-foreground)]">
          No folders match "{query}"
        </div>
      )}
    </div>
  )
}

// Helper to get filtered folders (exported for external use)
const getFilteredFolders = (
  folders: FolderType[],
  query: string,
  maxResults: number = 5
): FolderType[] => {
  if (!query.trim()) return []

  const lowerQuery = query.toLowerCase()
  return folders
    .filter(
      (folder) =>
        folder.name.toLowerCase().includes(lowerQuery) ||
        folder.path.toLowerCase().includes(lowerQuery)
    )
    .slice(0, maxResults)
}

export { QuickFileDropdown, getFilteredFolders }
