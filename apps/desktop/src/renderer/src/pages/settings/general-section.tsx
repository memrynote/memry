import { useCallback, useState } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { type Locale } from '@memry/contracts/locale-api'
import { useT } from '@memry/i18n/renderer'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useNoteFoldersQuery } from '@/hooks/use-notes-query'
import { useTabPreferences } from '@/hooks/use-tab-preferences'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { toUpdatePresentation } from '@/components/updater/update-presentation'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTelemetrySettings } from '@/hooks/use-telemetry-settings'
import { useReportIncident } from '@/components/diagnostics/incident-report-provider'
import { useVault } from '@/hooks/use-vault'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

type SettingsT = ReturnType<typeof useT>['t']

// Radix Select reserves '' so the vault root needs a sentinel value.
const ROOT_FOLDER_VALUE = '__root__'

const SEGMENT_ITEM =
  'h-auto min-w-0 rounded-[5px] border-none py-0.75 px-2.5 text-xs/4 text-muted-foreground shadow-none hover:bg-transparent data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]'

export function GeneralSettings() {
  const { t, i18n } = useT('settings')
  const { t: tCommon } = useT('common')
  const [isChangingLocale, setIsChangingLocale] = useState(false)
  const {
    settings: tabSettings,
    isLoading: tabLoading,
    updateSettings: updateTabSettings
  } = useTabPreferences()
  const {
    settings: generalSettings,
    isLoading: generalLoading,
    updateSettings: updateGeneralSettings
  } = useGeneralSettings()
  const {
    enabled: telemetryEnabled,
    isLoading: telemetryLoading,
    setEnabled: setTelemetryEnabled,
    autoSendDiagnostics,
    setAutoSendDiagnostics
  } = useTelemetrySettings()
  const {
    state: updateState,
    isLoading: updaterLoading,
    error: updaterError,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    setAutoCheck,
    setAutoDownload
  } = useAppUpdater()
  const { updateSettings: updateContextSettings } = useTabs()
  const { config, updateConfig } = useVault()
  const openIncidentReport = useReportIncident()

  const { folders } = useNoteFoldersQuery()

  const isLoading = tabLoading || generalLoading || telemetryLoading

  const handleStartOnBootChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ startOnBoot: enabled })
      if (!success) toast.error(t('general.startup.launchAtLogin.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleRestoreSessionChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateTabSettings({ restoreSessionOnStart: enabled })
      if (success) {
        updateContextSettings({ restoreSessionOnStart: enabled })
      } else {
        toast.error(t('general.tabs.error'))
      }
    },
    [t, updateTabSettings, updateContextSettings]
  )

  const handleOpenPagesInNewTabChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ openPagesInNewTab: enabled })
      if (!success) toast.error(t('general.tabs.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleMinimizeToTrayChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ minimizeToTray: enabled })
      if (!success) toast.error(t('general.window.minimizeToTray.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleCreateInSelectedFolderChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ createInSelectedFolder: enabled })
      if (!success) toast.error(t('general.tabs.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleDefaultNoteFolderChange = useCallback(
    (value: string) => {
      const defaultNoteFolder = value === ROOT_FOLDER_VALUE ? '' : value
      if (config && defaultNoteFolder !== config.defaultNoteFolder) {
        void updateConfig({ defaultNoteFolder })
      }
    },
    [config, updateConfig]
  )

  const handleTelemetryChange = useCallback(
    async (enabled: boolean) => {
      const success = await setTelemetryEnabled(enabled)
      if (!success) toast.error(t('general.privacy.telemetry.error'))
    },
    [t, setTelemetryEnabled]
  )

  const handleAutoSendDiagnosticsChange = useCallback(
    async (enabled: boolean) => {
      const success = await setAutoSendDiagnostics(enabled)
      if (!success) toast.error(t('general.privacy.autoSendDiagnostics.error'))
    },
    [t, setAutoSendDiagnostics]
  )

  const handleClockFormatChange = useCallback(
    async (value: '12h' | '24h') => {
      const success = await updateGeneralSettings({ clockFormat: value })
      if (!success) toast.error(t('general.clockFormat.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleDateFormatChange = useCallback(
    async (value: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY') => {
      const success = await updateGeneralSettings({ dateFormat: value })
      if (!success) toast.error(t('general.dateFormat.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleLocaleChange = useCallback(
    async (locale: Locale) => {
      setIsChangingLocale(true)
      try {
        await window.api.locale.set(locale)
        await i18n.changeLanguage(locale)
        toast.success(
          i18n.getFixedT(locale, 'settings')('general.language.changed', {
            nativeName: LOCALE_DISPLAY_NAMES[locale]
          })
        )
      } catch {
        toast.error(t('general.language.failed'))
      } finally {
        setIsChangingLocale(false)
      }
    },
    [i18n, t]
  )

  const handleCloseButtonChange = useCallback(
    async (value: 'always' | 'hover' | 'active') => {
      const success = await updateTabSettings({ tabCloseButton: value })
      if (success) {
        updateContextSettings({ tabCloseButton: value })
      } else {
        toast.error(t('general.tabs.error'))
      }
    },
    [t, updateTabSettings, updateContextSettings]
  )

  const handleUpdateAction = useCallback(async () => {
    try {
      if (!updateState.updateSupported) {
        toast.info(t('general.updates.unsupportedToast'))
        return
      }

      if (updateState.status === 'available') {
        await downloadUpdate()
        return
      }

      if (updateState.status === 'downloaded') {
        await quitAndInstall()
        return
      }

      const nextState = await checkForUpdates()
      if (nextState.status === 'up-to-date') {
        toast.success(t('general.updates.upToDateToast', { version: nextState.currentVersion }))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('general.updates.actionFailed'))
    }
  }, [
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    t,
    updateState.status,
    updateState.updateSupported
  ])

  const handleAutoCheckChange = useCallback(
    async (enabled: boolean) => {
      try {
        await setAutoCheck(enabled)
      } catch {
        toast.error(t('general.updates.autoCheck.error'))
      }
    },
    [setAutoCheck, t]
  )

  const handleAutoDownloadChange = useCallback(
    async (enabled: boolean) => {
      try {
        await setAutoDownload(enabled)
      } catch {
        toast.error(t('general.updates.autoDownload.error'))
      }
    },
    [setAutoDownload, t]
  )

  const updatePresentation = toUpdatePresentation(updateState)
  const updateRowLabel =
    updatePresentation.kind === 'downloading'
      ? tCommon('update.downloading', { version: updatePresentation.version })
      : updatePresentation.kind === 'available'
        ? tCommon('update.available')
        : updatePresentation.kind === 'ready'
          ? tCommon('update.ready')
          : updatePresentation.kind === 'failed'
            ? tCommon('update.failed')
            : tCommon('update.installing.titleUnknownVersion')
  const updateDescription = getUpdateDescription(updateState, updaterError, t, i18n.language)
  const defaultNoteFolder = config?.defaultNoteFolder ?? ''
  const folderOptions = folders.some((folder) => folder.path === defaultNoteFolder)
    ? folders
    : defaultNoteFolder
      ? [{ path: defaultNoteFolder }, ...folders]
      : folders
  const updateActionLabel = getUpdateActionLabel(updateState, t)
  const isUpdateActionDisabled =
    updaterLoading || updateState.status === 'checking' || updateState.status === 'downloading'

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('general.header.title')} subtitle={t('general.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('general.header.title')} subtitle={t('general.header.subtitle')} />

      <SettingsGroup label={t('general.groups.languageRegion')}>
        <SettingRow label={t('general.language.label')}>
          <Select
            value={i18n.language as Locale}
            onValueChange={(value) => void handleLocaleChange(value as Locale)}
            disabled={isChangingLocale}
          >
            <SelectTrigger id="language-select" className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              side="bottom"
              align="end"
              avoidCollisions={false}
              className="max-h-60 overflow-y-auto"
            >
              {SUPPORTED_LOCALES.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {LOCALE_DISPLAY_NAMES[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label={t('general.clockFormat.label')}>
          <ToggleGroup
            type="single"
            value={generalSettings.clockFormat}
            onValueChange={(value) => {
              if (value) void handleClockFormatChange(value as '12h' | '24h')
            }}
            aria-label={t('general.clockFormat.label')}
            className="gap-0 rounded-[7px] bg-muted p-0.5"
          >
            <ToggleGroupItem value="12h" className={SEGMENT_ITEM}>
              {t('general.clockFormat.options.12h')}
            </ToggleGroupItem>
            <ToggleGroupItem value="24h" className={SEGMENT_ITEM}>
              {t('general.clockFormat.options.24h')}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>

        <SettingRow label={t('general.dateFormat.label')}>
          <Select
            value={generalSettings.dateFormat}
            onValueChange={(value) =>
              void handleDateFormatChange(
                value as 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY'
              )
            }
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MM/DD/YYYY">
                {t('general.dateFormat.options.MM/DD/YYYY')}
              </SelectItem>
              <SelectItem value="DD/MM/YYYY">
                {t('general.dateFormat.options.DD/MM/YYYY')}
              </SelectItem>
              <SelectItem value="YYYY-MM-DD">
                {t('general.dateFormat.options.YYYY-MM-DD')}
              </SelectItem>
              <SelectItem value="DD.MM.YYYY">
                {t('general.dateFormat.options.DD.MM.YYYY')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.startupWindows')}>
        <SettingRow label={t('general.startup.launchAtLogin.label')}>
          <Switch
            checked={generalSettings.startOnBoot}
            onCheckedChange={(...args) => void handleStartOnBootChange(...args)}
            aria-label={t('general.startup.launchAtLogin.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label={t('general.tabs.restoreSession.label')}
          description={t('general.tabs.restoreSession.description')}
        >
          <Switch
            checked={tabSettings.restoreSessionOnStart}
            onCheckedChange={(...args) => void handleRestoreSessionChange(...args)}
            aria-label={t('general.tabs.restoreSession.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow label={t('general.tabs.openPagesInNewTab.label')}>
          <Switch
            checked={generalSettings.openPagesInNewTab}
            onCheckedChange={(...args) => void handleOpenPagesInNewTabChange(...args)}
            aria-label={t('general.tabs.openPagesInNewTab.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow label={t('general.tabs.closeButton.label')}>
          <Select
            value={tabSettings.tabCloseButton}
            onValueChange={(value) =>
              void handleCloseButtonChange(value as 'always' | 'hover' | 'active')
            }
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">{t('general.tabs.closeButton.options.always')}</SelectItem>
              <SelectItem value="hover">{t('general.tabs.closeButton.options.hover')}</SelectItem>
              <SelectItem value="active">{t('general.tabs.closeButton.options.active')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label={t('general.window.minimizeToTray.label')}>
          <Switch
            checked={generalSettings.minimizeToTray}
            onCheckedChange={(...args) => void handleMinimizeToTrayChange(...args)}
            aria-label={t('general.window.minimizeToTray.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.newNotes')}>
        <SettingRow
          label={t('general.fileCreation.defaultNoteFolder.label')}
          description={t('general.fileCreation.defaultNoteFolder.description')}
        >
          <Select
            value={defaultNoteFolder || ROOT_FOLDER_VALUE}
            onValueChange={handleDefaultNoteFolderChange}
            disabled={!config}
          >
            <SelectTrigger
              aria-label={t('general.fileCreation.defaultNoteFolder.label')}
              className={`${COMPACT_SELECT} max-w-56 font-mono`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="max-h-60 overflow-y-auto">
              <SelectItem value={ROOT_FOLDER_VALUE} className="font-mono text-xs/4">
                {t('general.fileCreation.defaultNoteFolder.root')}
              </SelectItem>
              {folderOptions.map((folder) => (
                <SelectItem key={folder.path} value={folder.path} className="font-mono text-xs/4">
                  /{folder.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label={t('general.fileCreation.createInSelectedFolder.label')}>
          <Switch
            checked={generalSettings.createInSelectedFolder}
            onCheckedChange={(...args) => void handleCreateInSelectedFolderChange(...args)}
            aria-label={t('general.fileCreation.createInSelectedFolder.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.updates')}>
        <SettingRow label={t('general.updates.label')} description={updateDescription}>
          <Button
            type="button"
            size="sm"
            variant={updateState.status === 'downloaded' ? 'default' : 'ghost'}
            disabled={isUpdateActionDisabled}
            onClick={() => void handleUpdateAction()}
            className="h-auto py-1 px-2 text-xs/4 font-normal"
          >
            {updateActionLabel}
          </Button>
        </SettingRow>
        <SettingRow label={t('general.updates.autoCheck.label')}>
          <Switch
            checked={updateState.autoCheckEnabled}
            disabled={!updateState.updateSupported}
            onCheckedChange={(...args) => void handleAutoCheckChange(...args)}
            aria-label={t('general.updates.autoCheck.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        <SettingRow label={t('general.updates.autoDownload.label')}>
          <Switch
            checked={updateState.autoDownloadEnabled}
            disabled={!updateState.updateSupported}
            onCheckedChange={(...args) => void handleAutoDownloadChange(...args)}
            aria-label={t('general.updates.autoDownload.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        {/* Same words as the sidebar row, from the same presentation model, so the
            two surfaces can never disagree about what phase the update is in. */}
        {updatePresentation.kind !== 'hidden' && (
          <SettingRow label={updateRowLabel}>
            <div className="flex items-center gap-3">
              {updatePresentation.kind !== 'downloading' &&
                'version' in updatePresentation &&
                updatePresentation.version && (
                  <span className="font-mono text-[11px] text-text-tertiary">
                    {updatePresentation.version}
                  </span>
                )}
              {(updatePresentation.kind === 'ready' || updatePresentation.kind === 'available') && (
                <Button
                  type="button"
                  size="sm"
                  variant={updatePresentation.kind === 'ready' ? 'default' : 'outline'}
                  onClick={() =>
                    void (updatePresentation.kind === 'ready' ? quitAndInstall() : downloadUpdate())
                  }
                >
                  {updatePresentation.kind === 'ready'
                    ? tCommon('update.popover.restartNow')
                    : tCommon('update.downloadAction')}
                </Button>
              )}
            </div>
          </SettingRow>
        )}
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.privacy')}>
        <SettingRow
          label={t('general.privacy.telemetry.label')}
          description={t('general.privacy.telemetry.description')}
        >
          <Switch
            checked={telemetryEnabled}
            onCheckedChange={(checked) => void handleTelemetryChange(checked)}
            aria-label={t('general.privacy.telemetry.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        <SettingRow
          label={t('general.privacy.autoSendDiagnostics.label')}
          description={t('general.privacy.autoSendDiagnostics.description')}
        >
          <Switch
            checked={autoSendDiagnostics}
            onCheckedChange={(checked) => void handleAutoSendDiagnosticsChange(checked)}
            aria-label={t('general.privacy.autoSendDiagnostics.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        <SettingRow label={t('general.privacy.diagnostics.sendReport.label')}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openIncidentReport({ source: 'settings' })}
            className="h-auto py-1.25 px-2.5 text-xs/4"
          >
            {t('general.privacy.diagnostics.sendReport.button')}
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

function getUpdateActionLabel(state: AppUpdateState, t: SettingsT): string {
  switch (state.status) {
    case 'checking':
      return t('general.updates.actions.checking')
    case 'available':
      return t('general.updates.actions.available')
    case 'downloading':
      return state.downloadProgressPercent == null
        ? t('general.updates.actions.downloading')
        : t('general.updates.actions.downloadingPercent', {
            percent: state.downloadProgressPercent
          })
    case 'downloaded':
      return t('general.updates.actions.downloaded')
    default:
      return t('general.updates.actions.idle')
  }
}

function getUpdateDescription(
  state: AppUpdateState,
  updaterError: string | null,
  t: SettingsT,
  locale: string
): string {
  if (!state.updateSupported) {
    return t('general.updates.status.unsupported')
  }

  if (updaterError) {
    return updaterError
  }

  if (state.error) {
    return state.error
  }

  const status = getUpdateStatus(state, t)
  if (state.lastCheckedAt == null || state.status === 'checking') return status
  return t('general.updates.checkedAgo', {
    status,
    time: formatRelativeTime(state.lastCheckedAt, locale)
  })
}

function getUpdateStatus(state: AppUpdateState, t: SettingsT): string {
  switch (state.status) {
    case 'available':
      return t('general.updates.status.available', { version: state.availableVersion ?? '' })
    case 'downloading':
      return state.downloadProgressPercent == null
        ? t('general.updates.status.downloading')
        : t('general.updates.status.downloadingPercent', {
            percent: state.downloadProgressPercent
          })
    case 'downloaded':
      return t('general.updates.status.downloaded', { version: state.availableVersion ?? '' })
    case 'up-to-date':
      return t('general.updates.status.upToDate')
    case 'checking':
      return t('general.updates.status.checking')
    default:
      return t('general.updates.status.idle')
  }
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(0, 'minute')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86400), 'day')
}
