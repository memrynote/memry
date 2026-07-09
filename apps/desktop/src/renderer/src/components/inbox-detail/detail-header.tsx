import { X } from '@/lib/icons'
import { formatCompactDate } from '@/services/inbox-service'
import { useT } from '@memry/i18n/renderer'

import { TypeIcon } from './content-section'
import type { InboxItemType } from '@/types'

interface DetailHeaderProps {
  type: InboxItemType
  createdAt: Date | string
  onClose: () => void
}

export const DetailHeader = ({
  type,
  createdAt,
  onClose
}: DetailHeaderProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const typeLabels: Record<InboxItemType, string> = {
    link: t('type.link'),
    note: t('type.note'),
    image: t('type.image'),
    voice: t('type.voice'),
    video: t('type.video'),
    clip: t('type.clip'),
    pdf: t('type.pdf'),
    social: t('type.social'),
    reminder: t('type.reminder')
  }

  return (
    <div className="flex items-center justify-between py-4 px-5 h-[47px] border-b border-border shrink-0">
      <div className="flex items-center gap-1.5">
        <TypeIcon type={type} className="size-3.5" />
        <span className="text-[11px] leading-3.5 text-muted-foreground">{typeLabels[type]}</span>
        <span className="text-[11px] leading-3.5 text-muted-foreground/60">
          · {formatCompactDate(createdAt)}
        </span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-surface-active/60 transition-all duration-150 ease-out active:scale-90"
        aria-label={t('detail.closePanel')}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
