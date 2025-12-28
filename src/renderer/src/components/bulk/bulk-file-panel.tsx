import { useState, useEffect, useCallback } from 'react'
import { Link, FileText, Image, Mic, Check, Loader2 } from 'lucide-react'

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FolderSelector } from '@/components/filing/folder-selector'
import { TagInput } from '@/components/filing/tag-input'
import {
  sampleFolders,
  getSuggestedFolders,
  getRecentFolders,
  suggestedTags
} from '@/data/filing-data'
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

  // Reset state when panel opens
  useEffect(() => {
    if (isOpen) {
      setSelectedFolder(null)
      setTags([])
    }
  }, [isOpen])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      // Cmd/Ctrl + Enter to file
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (selectedFolder && itemCount > 0) {
          handleFileItems()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedFolder, itemCount])

  const handleFolderSelect = useCallback((folder: Folder): void => {
    setSelectedFolder(folder)
  }, [])

  const handleTagsChange = useCallback((newTags: string[]): void => {
    setTags(newTags)
  }, [])

  const handleFileItems = async (): Promise<void> => {
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
  }

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
            <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/20">
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
            folders={sampleFolders}
            suggestedFolders={getSuggestedFolders()}
            recentFolders={getRecentFolders()}
            selectedFolder={selectedFolder}
            onSelect={handleFolderSelect}
          />

          <Separator />

          {/* Tags */}
          <TagInput tags={tags} suggestedTags={suggestedTags} onTagsChange={handleTagsChange} />

          <Separator />

          {/* Note about linking */}
          <p className="text-xs text-[var(--muted-foreground)] italic">
            Note: Links to other notes cannot be added when filing multiple items.
          </p>
        </div>

        {/* Footer */}
        <SheetFooter className="px-6 py-4 border-t border-[var(--border)] shrink-0 flex-col gap-3">
          <Button onClick={handleFileItems} disabled={!canFile} className="w-full" size="lg">
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
