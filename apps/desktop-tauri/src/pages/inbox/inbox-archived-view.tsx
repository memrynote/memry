import {
  InboxArchivedView as ArchivedViewComponent,
  type InboxArchivedViewProps
} from '@/components/inbox/inbox-archived-view'

export type { InboxArchivedViewProps }

export function InboxArchivedView(props: InboxArchivedViewProps): React.JSX.Element {
  return <ArchivedViewComponent {...props} />
}
