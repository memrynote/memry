import type { AppIcon } from '@/lib/icons'
import {
  FileText,
  Link2,
  Mic,
  Image,
  ArrowRight,
  Folder,
  StickyNote,
  File,
  Paperclip,
  MessageCircle,
  Bell,
  HelpCircle
} from '@/lib/icons'
import { formatCompactDate } from '@/services/inbox-service'
import type { InboxFilingHistoryEntry } from '../../../../preload/index.d'

export interface InboxFilingHistoryListProps {
  items: InboxFilingHistoryEntry[]
}

const TYPE_ICONS: Record<string, AppIcon> = {
  text: FileText,
  note: StickyNote,
  link: Link2,
  voice: Mic,
  image: Image,
  clip: Paperclip,
  pdf: File,
  social: MessageCircle,
  reminder: Bell
}

export function InboxFilingHistoryList({ items }: InboxFilingHistoryListProps): React.JSX.Element {
  if (!items || items.length === 0) {
    return (
      <div className="p-6 rounded-xl border border-border/50 bg-card h-full min-h-[400px] flex flex-col items-center justify-center">
        <div className="size-12 rounded-full bg-muted/50 flex items-center justify-center mb-3">
          <Folder className="size-5 text-muted-foreground" />
        </div>
        <p className="text-muted-foreground font-serif italic">No items filed yet</p>
      </div>
    )
  }

  const recentItems = items.slice(0, 10)

  return (
    <div className="p-6 rounded-xl border border-border/50 bg-card flex flex-col h-full">
      <div className="mb-6">
        <h3 className="text-lg font-serif font-medium text-foreground">Recently Filed</h3>
        <p className="text-sm text-muted-foreground mt-1">Latest actions on your inbox</p>
      </div>

      <div className="flex-1 overflow-auto -mx-2 px-2">
        <ul className="space-y-3">
          {recentItems.map((item) => {
            const Icon = TYPE_ICONS[item.itemType] || HelpCircle
            const isFolder = item.filedAction === 'folder' || item.filedTo.includes('/')

            return (
              <li
                key={item.id}
                className="group flex items-center gap-3 py-2 border-b border-border/30 last:border-0"
              >
                <div className="p-2 rounded-md bg-muted/50 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                  <Icon className="size-4" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-foreground truncate block max-w-[180px]">
                      {item.itemTitle || 'Untitled Item'}
                    </span>
                    <ArrowRight className="size-3 text-muted-foreground/50 flex-shrink-0" />
                    <div className="flex items-center gap-1 min-w-0">
                      {isFolder ? (
                        <Folder className="size-3 text-muted-foreground" />
                      ) : (
                        <StickyNote className="size-3 text-muted-foreground" />
                      )}
                      <span className="text-xs font-mono text-muted-foreground truncate">
                        {item.filedTo}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground/70">
                      {formatCompactDate(item.filedAt)}
                    </span>
                    {item.filedAction === 'linked' && (
                      <span className="text-[10px] uppercase tracking-wider font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-sm">
                        Linked
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
