import { InboxArchivedView as ArchivedViewComponent } from '@/components/inbox/inbox-archived-view'

export interface InboxArchivedViewProps {
  className?: string
}

export function InboxArchivedView({ className }: InboxArchivedViewProps): React.JSX.Element {
  return <ArchivedViewComponent className={className} />
}
