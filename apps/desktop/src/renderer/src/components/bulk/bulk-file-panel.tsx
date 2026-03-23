import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link, FileText, Image, Mic, Check, Loader2 } from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FolderSelector } from '@/components/filing/folder-selector'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import type { InboxItem, InboxItemListItem, InboxItemType, Folder } from '@/types'

// Bulk file panel can work with either full or list item types
type BulkItem = InboxItem | InboxItemListItem

// Item type icon component
const ItemTypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = 'size-4 text-[var(--muted-foreground)]'

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

// Item row in the list
const ItemRow = ({ item }: { item: BulkItem }): React.JSX.Element => {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <ItemTypeIcon type={item.type} />
      <span className="text-sm text-[var(--foreground)] truncate flex-1">{item.title}</span>
    </div>
  )
}

interface BulkFilePanelProps {
  isOpen: boolean
  items: BulkItem[]
  onClose: () => void
  onFile: (itemIds: string[], folderId: string, tags: string[]) => void
}

const BulkFilePanel = ({
  isOpen,
  items,
  onClose,
  onFile
}: BulkFilePanelProps): React.JSX.Element => {
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const itemCount = items.length

  // Fetch real folders from vault
  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const folderInfos = await window.api.notes.getFolders()
      const folders: Folder[] = [{ id: '', name: 'Notes (root)', path: '' }]
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
    enabled: isOpen // Only fetch when panel is open
  })

  // Calculate common tags across all selected items
  const commonTags = useMemo(() => {
    if (items.length === 0) return []
    // Get tags from first item
    const firstItemTags = new Set(items[0].tags || [])
    // Filter to only tags that exist in ALL items
    return [...firstItemTags].filter((tag) =>
      items.every((item) => (item.tags || []).includes(tag))
    )
  }, [items])

  // Get first 3 folders as suggested
  const suggestedFolders = useMemo(() => vaultFolders.slice(0, 3), [vaultFolders])

  // Handle filing items - defined before useEffect that uses it
  const handleFileItems = useCallback(async (): Promise<void> => {
    if (!selectedFolder || itemCount === 0) return

    setIsLoading(true)

    // Simulate a brief delay for filing
    await new Promise((resolve) => setTimeout(resolve, 500))

    onFile(
      items.map((item) => item.id),
      selectedFolder.id,
      tags
    )

    setIsLoading(false)
    onClose()
  }, [selectedFolder, itemCount, onFile, items, tags, onClose])

  // Reset state when panel opens, pre-populate with common tags
  useEffect(() => {
    if (isOpen) {
      setSelectedFolder(null)
      // Pre-populate with common tags shared by all selected items
      setTags(commonTags)
    }
  }, [isOpen, commonTags])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      // Cmd/Ctrl + Enter to file
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (selectedFolder && itemCount > 0) {
          void handleFileItems()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedFolder, itemCount, handleFileItems])

  const handleFolderSelect = useCallback((folder: Folder): void => {
    setSelectedFolder(folder)
  }, [])

  const handleTagsChange = useCallback((newTags: string[]): void => {
    setTags(newTags)
  }, [])

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      onClose()
    }
  }

  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
  const keyboardHint = isMac ? '⌘⏎ to file · Esc to close' : 'Ctrl+Enter to file · Esc to close'

  const canFile = selectedFolder !== null && !isLoading && itemCount > 0

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b border-[var(--border)] shrink-0">
          <SheetTitle className="text-lg font-semibold">
            File {itemCount} Item{itemCount !== 1 ? 's' : ''}
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Items to File */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Items to file
            </h3>
            <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/20">
              <ScrollArea className="max-h-[160px]">
                <div className="p-3 space-y-1">
                  {items.map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <Separator />

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

          {/* Note about linking */}
          <p className="text-xs text-[var(--muted-foreground)] italic">
            Note: Links to other notes cannot be added when filing multiple items.
          </p>
        </div>

        {/* Footer */}
        <SheetFooter className="px-6 py-4 border-t border-[var(--border)] shrink-0 flex-col gap-3">
          <Button
            onClick={() => void handleFileItems()}
            disabled={!canFile}
            className="w-full"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" aria-hidden="true" />
                Filing...
              </>
            ) : (
              <>
                {canFile && <Check className="size-4 mr-2" aria-hidden="true" />}
                File {itemCount} item{itemCount !== 1 ? 's' : ''}
              </>
            )}
          </Button>
          <p className="text-xs text-[var(--muted-foreground)] text-center">{keyboardHint}</p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export { BulkFilePanel }
