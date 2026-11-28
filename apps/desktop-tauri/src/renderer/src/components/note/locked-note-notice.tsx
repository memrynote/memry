import { Loader2, Lock } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

/**
 * Shown above every editor of a note the owner locked (#2606), or of one in an excluded folder
 * (`excluded`, #3530), which is read-only as well.
 */
export function LockedNoteNotice({
  className,
  excluded = false
}: {
  className?: string
  excluded?: boolean
}): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <div
      className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      data-testid="note-locked-indicator"
    >
      <Lock className="size-3.5" aria-hidden />
      <span>{t(excluded ? 'vaultLock.excludedIndicator' : 'vaultLock.readOnlyIndicator')}</span>
    </div>
  )
}

/**
 * Shown above the editor of every note while the vault's database is read-only on this device
 * (#4190): the editor takes no typing, since none of it could be saved.
 */
export function DatabaseReadOnlyNotice({ className }: { className?: string }): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <div
      className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      data-testid="note-database-read-only"
    >
      <Lock className="size-3.5" aria-hidden />
      <span>{t('editor.databaseReadOnly')}</span>
    </div>
  )
}

/**
 * Shown above the editor of a note whose server body has not arrived (#2536): typing into its
 * empty body would start a second body beside the one sync brings, so the editor takes none
 * until it lands.
 */
export function BodyNotPulledNotice({ className }: { className?: string }): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a live status strip; <output> would change its semantics as a form result
      role="status"
      aria-live="polite"
      className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      data-testid="note-body-not-pulled"
    >
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{t('editor.remoteBodyStuck')}</span>
    </div>
  )
}
