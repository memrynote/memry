import { AlertTriangle } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

interface StartFreshPanelProps {
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The way out of the recovery prompt for someone who cannot produce a recovery
 * phrase. Without it, a reinstall with no phrase and no second device leaves
 * uninstalling as the only remaining move (issue #1202).
 *
 * Deliberately never a default action: it is only reachable from a subdued
 * link, it states every consequence before the confirm button, and the confirm
 * button is the destructive variant. Signing out deletes this device's master
 * key, so anything already encrypted under it becomes unreadable for good —
 * that has to be a decision, never a slip.
 */
export function StartFreshPanel({ onConfirm, onCancel }: StartFreshPanelProps): React.JSX.Element {
  const { t } = useT('settings')

  const consequences = [
    t('setup.startFresh.consequenceSignOut'),
    t('setup.startFresh.consequenceKey'),
    t('setup.startFresh.consequenceLocal')
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10">
          <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h3 className="font-semibold text-base/5 tracking-[-0.01em] text-foreground">
            {t('setup.startFresh.title')}
          </h3>
          <p className="text-xs/4 text-muted-foreground">{t('setup.startFresh.description')}</p>
        </div>
      </div>

      <ul className="space-y-2 rounded-xl border border-border bg-muted/30 p-3 text-xs/4 text-muted-foreground">
        {consequences.map((consequence) => (
          <li key={consequence} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
            />
            <span>{consequence}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel}>
          {t('setup.startFresh.cancel')}
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          {t('setup.startFresh.confirm')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The subdued entry point to {@link StartFreshPanel}. Styled as a quiet link so
 * it never competes with "Restore access", but always present so the recovery
 * screen is never a dead end.
 */
export function StartFreshTrigger({ onClick }: { onClick: () => void }): React.JSX.Element {
  const { t } = useT('settings')

  return (
    <div className="flex justify-center pt-1">
      <button
        type="button"
        onClick={onClick}
        className="rounded-sm text-xs/4 text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {t('setup.startFresh.trigger')}
      </button>
    </div>
  )
}
