/**
 * BulkTagPopover Component
 * Popover for applying tags to multiple selected inbox items.
 * Uses TagAutocomplete for enhanced tag input with autocomplete.
 */

import { useState, useCallback, useEffect } from 'react'
import { Loader2 } from '@/lib/icons'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'

interface BulkTagPopoverProps {
  isOpen: boolean
  itemCount: number
  trigger: React.ReactNode
  onOpenChange: (open: boolean) => void
  onApplyTags: (tags: string[]) => void
}

const BulkTagPopover = ({
  isOpen,
  itemCount,
  trigger,
  onOpenChange,
  onApplyTags
}: BulkTagPopoverProps): React.JSX.Element => {
  // Reset tags when popover opens using key pattern instead of useEffect
  const [openCount, setOpenCount] = useState(0)
  const [prevIsOpen, setPrevIsOpen] = useState(false)

  // Track open state changes to reset tags
  if (isOpen && !prevIsOpen) {
    setOpenCount((c) => c + 1)
  }
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
  }

  const [tags, setTags] = useState<string[]>([])
  const [isApplying, setIsApplying] = useState(false)

  // Reset tags when openCount changes (popover opened)
  useEffect(() => {
    setTags([])
  }, [openCount])

  const handleTagsChange = useCallback((newTags: string[]): void => {
    setTags(newTags)
  }, [])

  const handleApplyTags = async (): Promise<void> => {
    if (tags.length === 0) return

    setIsApplying(true)

    // Brief delay for visual feedback
    await new Promise((resolve) => setTimeout(resolve, 200))

    onApplyTags(tags)
    setIsApplying(false)
    onOpenChange(false)
  }

  const canApply = tags.length > 0 && !isApplying

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="center" side="top" sideOffset={8}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm">
            Tag {itemCount} Item{itemCount !== 1 ? 's' : ''}
          </h3>
        </div>

        {/* Content */}
        <div className="p-4">
          <TagAutocomplete
            tags={tags}
            onTagsChange={handleTagsChange}
            placeholder="Type to search tags..."
            showSections={true}
            autoFocus={isOpen}
          />
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border">
          <Button
            onClick={() => void handleApplyTags()}
            disabled={!canApply}
            className="w-full"
            size="sm"
          >
            {isApplying ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" aria-hidden="true" />
                Applying...
              </>
            ) : (
              <>
                Apply to {itemCount} item{itemCount !== 1 ? 's' : ''}
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { BulkTagPopover }
