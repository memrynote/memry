import { InboxContentEditor } from './inbox-content-editor'
import type { InboxItem, InboxItemListItem } from '@/types'

type NoteItem = InboxItem | InboxItemListItem

interface NoteDetailProps {
  item: NoteItem
  onContentChange?: (content: string) => void
  onTitleChange?: (title: string) => void
}

export const NoteDetail = ({
  item,
  onContentChange,
  onTitleChange
}: NoteDetailProps): React.JSX.Element => (
  <div className="flex flex-col p-5 border-b border-border">
    <InboxContentEditor
      initialContent={item.content}
      onContentChange={onContentChange}
      onTitleChange={onTitleChange}
      editable={!!onContentChange}
      placeholder="Write your note..."
      className="!min-h-0 [&_.bn-editor]:!min-h-0"
    />
  </div>
)
