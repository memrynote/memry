import { ToolbarSegment, ToolbarSegmentTab } from '@/components/ui/page-toolbar'

export type InboxView = 'inbox' | 'archived' | 'insights'

const TABS: { id: InboxView; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'archived', label: 'Archived' },
  { id: 'insights', label: 'Insights' }
]

export interface InboxSegmentControlProps {
  value: InboxView
  onChange: (view: InboxView) => void
  className?: string
}

export function InboxSegmentControl({
  value,
  onChange,
  className
}: InboxSegmentControlProps): React.JSX.Element {
  return (
    <ToolbarSegment label="Inbox View Selection" className={className}>
      {TABS.map((tab, index) => (
        <ToolbarSegmentTab
          key={tab.id}
          isActive={value === tab.id}
          showBorder={index > 0}
          onClick={() => onChange(tab.id)}
        >
          <span className="text-[12px] leading-4">{tab.label}</span>
        </ToolbarSegmentTab>
      ))}
    </ToolbarSegment>
  )
}
