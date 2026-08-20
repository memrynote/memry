import { useCallback, useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { useTabPreferences } from '@/hooks/use-tab-preferences'
import { useAppUpdater } from '@/hooks/use-app-updater'
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
  SettingRowTall,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

type SettingsT = ReturnType<typeof useT>['t']

export function GeneralSettings() {
  const { t, i18n } = useT('settings')
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
    setEnabled: setTelemetryEnabled
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

  const [defaultNoteFolder, setDefaultNoteFolder] = useState('')

  useEffect(() => {
    if (config) setDefaultNoteFolder(config.defaultNoteFolder)
  }, [config])

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

  const handleCreateInSelectedFolderChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ createInSelectedFolder: enabled })
      if (!success) toast.error(t('general.tabs.error'))
    },
    [t, updateGeneralSettings]
  )

  const handleDefaultNoteFolderBlur = useCallback(() => {
    if (config && defaultNoteFolder !== config.defaultNoteFolder) {
      void updateConfig({ defaultNoteFolder })
    }
  }, [config, defaultNoteFolder, updateConfig])

  const handleTelemetryChange = useCallback(
    async (enabled: boolean) => {
      const success = await setTelemetryEnabled(enabled)
      if (!success) toast.error(t('general.privacy.telemetry.error'))
    },
    [t, setTelemetryEnabled]
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

  const updateDescription = getUpdateDescription(updateState, updaterError, t)
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

      <SettingsGroup label={t('general.groups.startup')}>
        <SettingRow
          label={t('general.startup.launchAtLogin.label')}
          description={t('general.startup.launchAtLogin.description')}
        >
          <Switch
            checked={generalSettings.startOnBoot}
            onCheckedChange={(...args) => void handleStartOnBootChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.updates')}>
        <SettingRow
          label={t('general.updates.autoCheck.label')}
          description={t('general.updates.autoCheck.description')}
        >
          <Switch
            checked={updateState.autoCheckEnabled}
            disabled={!updateState.updateSupported}
            onCheckedChange={(...args) => void handleAutoCheckChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        <SettingRow
          label={t('general.updates.autoDownload.label')}
          description={t('general.updates.autoDownload.description')}
        >
          <Switch
            checked={updateState.autoDownloadEnabled}
            disabled={!updateState.updateSupported}
            onCheckedChange={(...args) => void handleAutoDownloadChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        <SettingRowTall label={t('general.updates.appUpdates')} description={updateDescription}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1 text-xs/4 text-muted-foreground">
              <span>
                {t('general.updates.installedVersion', { version: updateState.currentVersion })}
              </span>
              {updateState.availableVersion && (
                <span>
                  {t('general.updates.availableVersion', {
                    version: updateState.availableVersion
                  })}
                </span>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant={updateState.status === 'downloaded' ? 'default' : 'outline'}
              disabled={isUpdateActionDisabled}
              onClick={() => void handleUpdateAction()}
            >
              {updateActionLabel}
            </Button>
          </div>
        </SettingRowTall>
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.languageRegion')}>
        <SettingRow label={t('general.language.label')} description={t('general.language.helper')}>
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

        <SettingRow
          label={t('general.clockFormat.label')}
          description={t('general.clockFormat.description')}
        >
          <Select
            value={generalSettings.clockFormat}
            onValueChange={(value) => void handleClockFormatChange(value as '12h' | '24h')}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="12h">{t('general.clockFormat.options.12h')}</SelectItem>
              <SelectItem value="24h">{t('general.clockFormat.options.24h')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('general.dateFormat.label')}
          description={t('general.dateFormat.description')}
        >
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

      <SettingsGroup label={t('general.groups.tabBehavior')}>
        <SettingRow
          label={t('general.tabs.openPagesInNewTab.label')}
          description={t('general.tabs.openPagesInNewTab.description')}
        >
          <Switch
            checked={generalSettings.openPagesInNewTab}
            onCheckedChange={(...args) => void handleOpenPagesInNewTabChange(...args)}
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
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label={t('general.tabs.closeButton.label')}
          description={t('general.tabs.closeButton.description')}
        >
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
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.fileCreation')}>
        <SettingRow
          label={t('general.fileCreation.createInSelectedFolder.label')}
          description={t('general.fileCreation.createInSelectedFolder.description')}
        >
          <Switch
            checked={generalSettings.createInSelectedFolder}
            onCheckedChange={(...args) => void handleCreateInSelectedFolderChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label={t('general.fileCreation.defaultNoteFolder.label')}
          description={t('general.fileCreation.defaultNoteFolder.description')}
        >
          <Input
            value={defaultNoteFolder}
            onChange={(e) => setDefaultNoteFolder(e.target.value)}
            onBlur={handleDefaultNoteFolderBlur}
            placeholder={t('general.fileCreation.defaultNoteFolder.placeholder')}
            className="h-7 w-40 text-xs/4"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('general.groups.privacy')}>
        <SettingRow
          label={t('general.privacy.telemetry.label')}
          description={t('general.privacy.telemetry.description')}
        >
          <Switch
            checked={telemetryEnabled}
            onCheckedChange={(checked) => void handleTelemetryChange(checked)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
        <SettingRowTall
          label={t('general.privacy.diagnostics.sendReport.label')}
          description={t('general.privacy.diagnostics.sendReport.description')}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openIncidentReport({ source: 'settings' })}
          >
            {t('general.privacy.diagnostics.sendReport.button')}
          </Button>
        </SettingRowTall>
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
  t: SettingsT
): string {
  if (!state.updateSupported) {
    return t('general.updates.unsupported')
  }

  if (updaterError) {
    return updaterError
  }

  if (state.error) {
    return state.error
  }

  switch (state.status) {
    case 'available':
      return t('general.updates.available', { version: state.availableVersion ?? '' })
    case 'downloading':
      return state.downloadProgressPercent == null
        ? t('general.updates.downloadingLatest')
        : t('general.updates.downloadingLatestPercent', {
            percent: state.downloadProgressPercent
          })
    case 'downloaded':
      return t('general.updates.downloaded', { version: state.availableVersion ?? '' })
    case 'up-to-date':
      return t('general.updates.upToDate')
    case 'checking':
      return t('general.updates.checking')
    default:
      return t('general.updates.idle')
  }
}
