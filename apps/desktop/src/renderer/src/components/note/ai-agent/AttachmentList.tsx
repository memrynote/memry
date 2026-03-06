import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { AttachmentChip } from './AttachmentChip'
import type { Attachment } from './types'

interface AttachmentListProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

export function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <ScrollArea className="w-full whitespace-nowrap">
      <div className="flex gap-2 pb-2">
        {attachments.map((attachment) => (
          <AttachmentChip key={attachment.id} attachment={attachment} onRemove={onRemove} />
        ))}
      </div>
      <ScrollBar orientation="horizontal" className="h-1.5" />
    </ScrollArea>
  )
}
