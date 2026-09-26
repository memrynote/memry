import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  ACCENT_SWITCH,
  COMPACT_SELECT,
  SettingsGroup,
  SettingsHeader,
  SettingRow
} from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'

type TerminalCommandStatus = Awaited<
  ReturnType<typeof window.api.settings.getTerminalCommandStatus>
>

export function CommandLineSettings({
  embedded = false
}: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useT('settings')
  const [status, setStatus] = useState<TerminalCommandStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isChanging, setIsChanging] = useState(false)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      setStatus(await window.api.settings.getTerminalCommandStatus())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('commandLine.status.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setIsChanging(true)
      try {
        const result = enabled
          ? await window.api.settings.installTerminalCommand()
          : await window.api.settings.uninstallTerminalCommand()

        if (result.status) setStatus(result.status)

        if (!result.success) {
          toast.error(result.error)
          return
        }

        toast.success(
          enabled
            ? t('commandLine.status.installedToast')
            : t('commandLine.status.uninstalledToast')
        )
      } finally {
        setIsChanging(false)
      }
    },
    [t]
  )

  const handleDefaultVaultChange = useCallback(
    async (vaultPath: string) => {
      if (vaultPath === 'none') return
      setIsChanging(true)
      try {
        const result = await window.api.settings.setTerminalCommandDefaultVault(vaultPath)
        if (result.status) setStatus(result.status)
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success(t('commandLine.status.defaultVaultUpdatedToast'))
      } finally {
        setIsChanging(false)
      }
    },
    [t]
  )

  const installed = status?.installed ?? false
  const vaults = status?.vaults ?? []
  const defaultVaultPath = status?.defaultVaultPath ?? 'none'
  const defaultVaultDescription =
    status?.defaultVaultPath && status.vaults.length > 0
      ? t('commandLine.defaultVault.descriptionSelected', { path: status.defaultVaultPath })
      : t('commandLine.defaultVault.description')

  return (
    <div className="flex flex-col text-xs/4">
      {!embedded && (
        <SettingsHeader
          title={t('commandLine.header.title')}
          subtitle={t('commandLine.header.subtitle')}
        />
      )}

      <div className="flex items-baseline justify-between gap-4 pb-1.5">
        <h4 className="font-semibold text-xs/4 text-foreground">
          {t(embedded ? 'commandLine.header.title' : 'commandLine.groups.terminal')}
        </h4>
        <button
          type="button"
          className="shrink-0 rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          disabled={isLoading || isChanging}
          onClick={() => void refresh()}
        >
          {t('commandLine.actions.refresh')}
        </button>
      </div>
      <SettingsGroup>
        <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px]/4 text-foreground">{t('commandLine.command.label')}</span>
            {!status ? (
              <span className="text-xs/4 text-muted-foreground">
                {t('commandLine.status.loading')}
              </span>
            ) : installed ? (
              <span
                className="truncate font-mono text-xs/4 text-muted-foreground"
                title={t('commandLine.command.descriptionInstalled', { path: status.shimPath })}
              >
                {status.shimPath}
              </span>
            ) : (
              <span className="text-xs/4 text-muted-foreground">
                {t('commandLine.command.descriptionNotInstalled')}
              </span>
            )}
            {status?.pathHint && (
              <span className="text-xs/4 text-muted-foreground">{status.pathHint}</span>
            )}
          </div>
          <Switch
            checked={installed}
            disabled={isLoading || isChanging || !status?.supported}
            onCheckedChange={(...args) => void handleToggle(...args)}
            className={ACCENT_SWITCH}
            aria-label={t('commandLine.command.toggleLabel')}
          />
        </div>
        <SettingRow
          label={t('commandLine.defaultVault.label')}
          description={defaultVaultDescription}
        >
          <Select
            value={defaultVaultPath}
            // Don't disable on isChanging: flipping disabled mid-select releases the
            // trigger's pointer capture, so the pointerup leaks to the settings Dialog
            // overlay and dismisses it. (Same class as the self-disabling-button gotcha.)
            disabled={isLoading || vaults.length === 0}
            onValueChange={(value) => void handleDefaultVaultChange(value)}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue placeholder={t('commandLine.defaultVault.placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {(vaults.length === 0 || !status?.defaultVaultPath) && (
                <SelectItem value="none">{t('commandLine.defaultVault.none')}</SelectItem>
              )}
              {vaults.map((vault) => (
                <SelectItem key={vault.path} value={vault.path}>
                  {vault.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
