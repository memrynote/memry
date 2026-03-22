import { InboxContentEditor } from './inbox-content-editor'
import type { InboxItem, InboxItemListItem } from '@/types'

type NoteItem = InboxItem | InboxItemListItem

interface NoteDetailProps {
  item: NoteItem
  onContentChange?: (content: string) => void
}

export const NoteDetail = ({ item, onContentChange }: NoteDetailProps): React.JSX.Element => (
  <div className="flex flex-col gap-3.5 p-5 border-b border-border">
    <h3 className="text-[15px] leading-5 font-medium text-foreground">{item.title}</h3>

    <div className="flex flex-col gap-1.5">
      <span className="uppercase tracking-[0.04em] text-[11px] leading-3.5 font-medium text-muted-foreground/60">
        Content
      </span>
      <div className="flex flex-col min-h-30 rounded-lg bg-muted/5 border border-border p-3">
        <InboxContentEditor
          initialContent={item.content}
          onContentChange={onContentChange}
          editable={!!onContentChange}
          placeholder="Write your note..."
          className="!min-h-0 [&_.bn-editor]:!min-h-0"
        />
      </div>
    </div>
  </div>
)
