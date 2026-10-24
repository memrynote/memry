import { useT } from '@memry/i18n/renderer'

interface UpdatingScreenProps {
  version?: string | null
}

/**
 * Full-window screen shown while an update is being installed and the app is
 * restarting. Intentionally self-contained — reads no vault data — so it stays
 * up cleanly while the vault tears down during the quit-to-install shutdown.
 *
 * A single breathing dot rather than a spinner: nothing here is at risk, so the
 * screen should read as waiting, not as working.
 */
export function UpdatingScreen({ version }: UpdatingScreenProps) {
  const { t } = useT('common')

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <span
        aria-hidden="true"
        className="size-[7px] rounded-full bg-[var(--tint)] animate-pulse motion-reduce:animate-none"
      />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium">
          {version
            ? t('update.installing.title', { version })
            : t('update.installing.titleUnknownVersion')}
        </p>
        <p className="text-xs text-text-tertiary">{t('update.installing.subtitle')}</p>
      </div>
    </div>
  )
}
