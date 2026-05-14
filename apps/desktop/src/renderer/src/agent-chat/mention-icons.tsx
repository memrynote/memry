import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import type { InboxItemType } from '@memry/contracts/inbox-api'

import {
  Bell,
  FileText,
  Folder,
  Image,
  Link,
  Mic,
  Package,
  Scissors,
  Share2,
  Video
} from '@/lib/icons'
import {
  SidebarCalendar,
  SidebarInbox,
  SidebarJournal,
  SidebarTasks
} from '@/lib/icons/sidebar-nav-icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { cn } from '@/lib/utils'

export type MentionIconSpec =
  | { kind: 'note'; emoji?: string | null }
  | { kind: 'current_note' }
  | { kind: 'task' }
  | { kind: 'journal' }
  | { kind: 'inbox'; itemType?: InboxItemType | null }
  | { kind: 'calendar_event' }
  | { kind: 'folder' }
  | { kind: 'project' }

export type MentionAttachment = AttachmentInput & {
  icon: MentionIconSpec
}

export function mentionColorForKind(kind: AttachmentInput['kind']): string {
  switch (kind) {
    case 'note':
    case 'current_note':
      return 'bg-sky-500/10 text-sky-700 ring-sky-500/15 dark:text-sky-300'
    case 'task':
      return 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/15 dark:text-emerald-300'
    case 'inbox':
      return 'bg-amber-500/10 text-amber-700 ring-amber-500/15 dark:text-amber-300'
    case 'calendar_event':
      return 'bg-violet-500/10 text-violet-700 ring-violet-500/15 dark:text-violet-300'
    case 'journal':
      return 'bg-rose-500/10 text-rose-700 ring-rose-500/15 dark:text-rose-300'
    case 'folder':
    case 'project':
      return 'bg-stone-500/10 text-stone-700 ring-stone-500/15 dark:text-stone-300'
  }
}

function InboxMentionIcon({
  itemType,
  className
}: {
  itemType?: InboxItemType | null
  className: string
}): React.JSX.Element {
  switch (itemType) {
    case 'link':
      return <Link className={className} aria-hidden="true" />
    case 'note':
      return <FileText className={className} aria-hidden="true" />
    case 'image':
      return <Image className={className} aria-hidden="true" />
    case 'voice':
      return <Mic className={className} aria-hidden="true" />
    case 'video':
      return <Video className={className} aria-hidden="true" />
    case 'clip':
      return <Scissors className={className} aria-hidden="true" />
    case 'pdf':
      return <FileText className={className} aria-hidden="true" />
    case 'social':
      return <Share2 className={className} aria-hidden="true" />
    case 'reminder':
      return <Bell className={className} aria-hidden="true" />
    default:
      return <SidebarInbox className={className} aria-hidden="true" />
  }
}

export function MentionIcon({
  icon,
  className
}: {
  icon: MentionIconSpec
  className?: string
}): React.JSX.Element {
  const iconClassName = cn('size-4 shrink-0 text-muted-foreground', className)
  if (icon.kind === 'note' && icon.emoji) {
    return (
      <NoteIconDisplay
        value={icon.emoji}
        className={cn(iconClassName, 'inline-flex items-center justify-center leading-none')}
      />
    )
  }

  switch (icon.kind) {
    case 'task':
      return <SidebarTasks className={iconClassName} aria-hidden="true" />
    case 'journal':
      return <SidebarJournal className={iconClassName} aria-hidden="true" />
    case 'inbox':
      return <InboxMentionIcon itemType={icon.itemType} className={iconClassName} />
    case 'calendar_event':
      return <SidebarCalendar className={iconClassName} aria-hidden="true" />
    case 'folder':
      return <Folder className={iconClassName} aria-hidden="true" />
    case 'project':
      return <Package className={iconClassName} aria-hidden="true" />
    case 'note':
    case 'current_note':
      return <FileText className={iconClassName} aria-hidden="true" />
  }
}
