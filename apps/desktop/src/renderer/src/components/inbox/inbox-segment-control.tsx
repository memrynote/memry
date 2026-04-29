import { ToolbarSegment, ToolbarSegmentTab } from '@/components/ui/page-toolbar'
import { useT } from '@memry/i18n/renderer'

export type InboxView = 'inbox' | 'archived' | 'insights'

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
  const { t } = useT('inbox')
  const tabs = [
    { id: 'inbox', label: t('view.tabs.inbox') },
    { id: 'archived', label: t('view.tabs.archived') },
    { id: 'insights', label: t('view.tabs.insights') }
  ] as const

  return (
    <ToolbarSegment label={t('view.tabs.ariaLabel')} className={className}>
      {tabs.map((tab, index) => (
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
