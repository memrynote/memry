import { Loader2 } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

interface UpdatingScreenProps {
  version?: string | null
}

/**
 * Full-window screen shown while an update is being installed and the app is
 * restarting. Intentionally self-contained — reads no vault data — so it stays
 * up cleanly while the vault tears down during the quit-to-install shutdown.
 */
export function UpdatingScreen({ version }: UpdatingScreenProps) {
  const { t } = useT('common')

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <Loader2 className="size-7 animate-spin text-sidebar-terracotta" />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium">
          {t('phaseF.componentsAppSidebar.updateInstallingTitle')}
          {version ? ` · ${version}` : ''}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('phaseF.componentsAppSidebar.updateInstallingSubtitle')}
        </p>
      </div>
    </div>
  )
}
