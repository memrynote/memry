import { useState, useEffect, useCallback, useMemo } from "react"
import { Link, FileText, Image, Mic, Globe, Check, Loader2 } from "lucide-react"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { FolderSelector } from "@/components/filing/folder-selector"
import { TagInput } from "@/components/filing/tag-input"
import { LinkSearch } from "@/components/filing/link-search"
import {
  sampleFolders,
  getSuggestedFolders,
  getRecentFolders,
  suggestedTags,
  existingNotes,
} from "@/data/filing-data"
import { extractDomain } from "@/lib/inbox-utils"
import { isMac, isInputFocused } from "@/hooks/use-keyboard-shortcuts"
import type { InboxItem, InboxItemType, Folder, LinkedNote } from "@/types"

// Item preview icon component
const ItemTypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = "size-5 text-[var(--muted-foreground)]"

  switch (type) {
    case "link":
      return <Link className={iconClass} aria-hidden="true" />
    case "note":
      return <FileText className={iconClass} aria-hidden="true" />
    case "image":
      return <Image className={iconClass} aria-hidden="true" />
    case "voice":
      return <Mic className={iconClass} aria-hidden="true" />
  }
}

// Item preview component
interface ItemPreviewProps {
  item: InboxItem
}

const ItemPreview = ({ item }: ItemPreviewProps): React.JSX.Element => {
  const getSubtitle = (): string => {
    switch (item.type) {
      case "link":
        return item.url ? extractDomain(item.url) : ""
      case "note":
        return item.content?.slice(0, 50) || ""
      case "image":
        return "Image file"
      case "voice":
        return item.duration ? `${Math.floor(item.duration / 60)}:${(item.duration % 60).toString().padStart(2, "0")}` : "Voice memo"
    }
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--muted)]/30 border border-[var(--border)]/50">
      <div className="size-10 rounded-lg bg-[var(--muted)] flex items-center justify-center shrink-0">
        {item.type === "link" ? (
          <Globe className="size-5 text-[var(--muted-foreground)]" aria-hidden="true" />
        ) : (
          <ItemTypeIcon type={item.type} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--foreground)] truncate">
          {item.title}
        </p>
        <p className="text-xs text-[var(--muted-foreground)] truncate">
          {getSubtitle()}
        </p>
      </div>
    </div>
  )
}

interface FilingPanelProps {
  isOpen: boolean
  item: InboxItem | null
  onClose: () => void
  onFile: (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]) => void
}

const FilingPanel = ({
  isOpen,
  item,
  onClose,
  onFile,
}: FilingPanelProps): React.JSX.Element => {
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [linkedNotes, setLinkedNotes] = useState<LinkedNote[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Get suggested folders for number shortcuts
  const suggestedFoldersForShortcut = useMemo(() => getSuggestedFolders(), [])

  // Reset state when panel opens with new item
  useEffect(() => {
    if (isOpen && item) {
      setSelectedFolder(null)
      setTags([])
      setLinkedNotes([])
    }
  }, [isOpen, item?.id])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      // Skip if typing in an input field
      if (isInputFocused()) return

      // Cmd/Ctrl + Enter to file
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
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

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
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

  const modifierKeyDisplay = isMac ? "⌘" : "Ctrl+"
  const keyboardHint = `${modifierKeyDisplay}⏎ file · 1-5 folder · Esc close`

  const canFile = selectedFolder !== null && !isLoading

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] sm:max-w-[420px] flex flex-col p-0"
      >
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b border-[var(--border)] shrink-0">
          <SheetTitle className="text-lg font-semibold">File Item</SheetTitle>
        </SheetHeader>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Item Preview */}
          {item && <ItemPreview item={item} />}

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
          <TagInput
            tags={tags}
            suggestedTags={suggestedTags}
            onTagsChange={handleTagsChange}
          />

          <Separator />

          {/* Link to Notes */}
          <LinkSearch
            availableNotes={existingNotes}
            linkedNotes={linkedNotes}
            onLinkedNotesChange={handleLinkedNotesChange}
          />
        </div>

        {/* Footer */}
        <SheetFooter className="px-6 py-4 border-t border-[var(--border)] shrink-0 flex-col gap-3">
          <Button
            onClick={handleFileItem}
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
                File item
              </>
            )}
          </Button>
          <p className="text-xs text-[var(--muted-foreground)] text-center">
            {keyboardHint}
          </p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export { FilingPanel }

