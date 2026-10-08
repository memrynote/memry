import { Lock } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

/** Shown above every editor of a note the owner locked (#2606). */
export function LockedNoteNotice({ className }: { className?: string }): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <div
      className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      data-testid="note-locked-indicator"
    >
      <Lock className="size-3.5" aria-hidden />
      <span>{t('vaultLock.readOnlyIndicator')}</span>
    </div>
  )
}
