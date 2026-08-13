import { useCallback, useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Lock } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useVault } from '@/hooks/use-vault'
import { formatJournalFilename } from '@memry/storage-vault/journal-format'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

export function JournalSettings() {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const { templates, isLoading: isLoadingTemplates } = useTemplates()
  const {
    settings,
    updateSettings,
    setDefaultTemplate,
    isLoading: isLoadingSettings
  } = useJournalSettings()
  const { config, updateConfig } = useVault()

  const [journalFolder, setJournalFolder] = useState('')
  const [journalDateFormat, setJournalDateFormat] = useState('')

  // Sync editable copies whenever the persisted vault config loads or changes.
  useEffect(() => {
    if (!config) return
    setJournalFolder(config.journalFolder)
    setJournalDateFormat(config.journalDateFormat)
  }, [config])

  const handleJournalFolderBlur = useCallback(() => {
    if (config && journalFolder !== config.journalFolder) {
      void updateConfig({ journalFolder })
    }
  }, [config, journalFolder, updateConfig])

  const handleJournalDateFormatBlur = useCallback(() => {
    if (config && journalDateFormat !== config.journalDateFormat) {
      void updateConfig({ journalDateFormat })
    }
  }, [config, journalDateFormat, updateConfig])

  const todayIso = new Date().toISOString().slice(0, 10)
  const previewFilename = `${formatJournalFilename(todayIso, journalDateFormat)}.md`
  const previewPath = journalFolder ? `${journalFolder}/${previewFilename}` : previewFilename

  const handleTemplateChange = useCallback(
    async (value: string) => {
      const templateId = value === 'none' ? null : value
      const success = await setDefaultTemplate(templateId)
      if (success) {
        toast.success(templateId ? t('journal.template.updated') : t('journal.template.cleared'))
      } else {
        toast.error(t('journal.template.error'))
      }
    },
    [setDefaultTemplate, t]
  )

  const handleShowStatsFooterChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showStatsFooter: checked })
      if (!success) toast.error(t('journal.updateError'))
    },
    [t, updateSettings]
  )

  const defaultTemplateName = settings.defaultTemplate
    ? templates.find((t) => t.id === settings.defaultTemplate)?.name
    : null

  if (isLoadingSettings) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('journal.header.title')} subtitle={t('journal.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('journal.header.title')} subtitle={t('journal.header.subtitle')} />

      <SettingsGroup label={t('journal.groups.defaultTemplate')}>
        <SettingRow
          label={t('journal.template.label')}
          description={t('journal.template.description')}
        >
          <Select
            value={settings.defaultTemplate ?? 'none'}
            onValueChange={(...args) => void handleTemplateChange(...args)}
            disabled={isLoadingTemplates || isLoadingSettings}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue placeholder={t('journal.template.placeholder')}>
                {isLoadingSettings
                  ? tCommon('state.loading')
                  : settings.defaultTemplate
                    ? (defaultTemplateName ?? t('journal.template.unknown'))
                    : t('journal.template.none')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('journal.template.noneAsk')}</SelectItem>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  <span className="flex items-center gap-2">
                    {template.icon && <span>{template.icon}</span>}
                    {template.name}
                    {template.isBuiltIn && <Lock className="w-3 h-3 text-muted-foreground ms-1" />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('journal.groups.location')}>
        <SettingRow label={t('journal.folder.label')} description={t('journal.folder.description')}>
          <Input
            value={journalFolder}
            onChange={(e) => setJournalFolder(e.target.value)}
            onBlur={handleJournalFolderBlur}
            placeholder={t('journal.folder.placeholder')}
            className="h-7 w-40 text-xs/4"
          />
        </SettingRow>

        <SettingRow
          label={t('journal.dateFormat.label')}
          description={t('journal.dateFormat.description')}
        >
          <Input
            value={journalDateFormat}
            onChange={(e) => setJournalDateFormat(e.target.value)}
            onBlur={handleJournalDateFormatBlur}
            placeholder={t('journal.dateFormat.placeholder')}
            className="h-7 w-40 text-xs/4"
          />
        </SettingRow>

        <SettingRow
          label={t('journal.preview.label')}
          description={t('journal.preview.description')}
        >
          <span className="font-mono text-xs/4 text-muted-foreground">{previewPath}</span>
        </SettingRow>
      </SettingsGroup>

      {/*
       * No "Sidebar Visibility" group. All three of its rows controlled nothing:
       * JournalDayPanel gates its schedule and task sections on feature flags and emptiness
       * only, never on `showSchedule` / `showTasks`, and nothing renders AIConnectionsPanel at
       * all. `journal.showSchedule`, `journal.showTasks`, and `journal.showAIConnections` stay
       * persisted and readable/writable through settings so existing installs keep their values
       * and re-exposing the rows later is a UI-only change.
       */}

      <SettingsGroup label={t('journal.groups.footer')}>
        <SettingRow
          label={t('journal.showStatsFooter.label')}
          description={t('journal.showStatsFooter.description')}
        >
          <Switch
            checked={settings.showStatsFooter}
            onCheckedChange={(...args) => void handleShowStatsFooterChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
