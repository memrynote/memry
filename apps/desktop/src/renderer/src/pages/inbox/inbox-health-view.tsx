import { InboxInsightsView } from '@/components/inbox/inbox-insights-view'

export interface InboxHealthViewProps {
  className?: string
}

export function InboxHealthView({ className }: InboxHealthViewProps): React.JSX.Element {
  return <InboxInsightsView className={className} />
}
