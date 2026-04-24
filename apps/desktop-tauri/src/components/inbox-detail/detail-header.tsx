import { X } from '@/lib/icons'
import { formatCompactDate } from '@/services/inbox-service'

import { TypeIcon } from './content-section'
import { getTypeLabel } from './type-accents'
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
}: DetailHeaderProps): React.JSX.Element => (
  <div className="flex items-center justify-between py-4 px-5 h-[47px] border-b border-border shrink-0">
    <div className="flex items-center gap-1.5">
      <TypeIcon type={type} className="size-3.5" />
      <span className="text-[11px] leading-3.5 text-muted-foreground">{getTypeLabel(type)}</span>
      <span className="text-[11px] leading-3.5 text-muted-foreground/60">
        · {formatCompactDate(createdAt)}
      </span>
    </div>
    <button
      onClick={onClose}
      className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground transition-colors"
      aria-label="Close panel"
    >
      <X className="size-3.5" />
    </button>
  </div>
)
