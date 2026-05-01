import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Lock } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
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

  const handleShowScheduleChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showSchedule: checked })
      if (!success) toast.error(t('journal.updateError'))
    },
    [t, updateSettings]
  )

  const handleShowTasksChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showTasks: checked })
      if (!success) toast.error(t('journal.updateError'))
    },
    [t, updateSettings]
  )

  const handleShowAIConnectionsChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showAIConnections: checked })
      if (!success) toast.error(t('journal.updateError'))
    },
    [t, updateSettings]
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

      <SettingsGroup label={t('journal.groups.sidebarVisibility')}>
        <SettingRow
          label={t('journal.showSchedule.label')}
          description={t('journal.showSchedule.description')}
        >
          <Switch
            checked={settings.showSchedule}
            onCheckedChange={(...args) => void handleShowScheduleChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label={t('journal.showTasks.label')}
          description={t('journal.showTasks.description')}
        >
          <Switch
            checked={settings.showTasks}
            onCheckedChange={(...args) => void handleShowTasksChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label={t('journal.showAIConnections.label')}
          description={t('journal.showAIConnections.description')}
        >
          <Switch
            checked={settings.showAIConnections}
            onCheckedChange={(...args) => void handleShowAIConnectionsChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

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
