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
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

export function JournalSettings() {
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
        toast.success(templateId ? 'Default template updated' : 'Default template cleared')
      } else {
        toast.error('Failed to update default template')
      }
    },
    [setDefaultTemplate]
  )

  const handleShowScheduleChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showSchedule: checked })
      if (!success) toast.error('Failed to update setting')
    },
    [updateSettings]
  )

  const handleShowTasksChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showTasks: checked })
      if (!success) toast.error('Failed to update setting')
    },
    [updateSettings]
  )

  const handleShowAIConnectionsChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showAIConnections: checked })
      if (!success) toast.error('Failed to update setting')
    },
    [updateSettings]
  )

  const handleShowStatsFooterChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showStatsFooter: checked })
      if (!success) toast.error('Failed to update setting')
    },
    [updateSettings]
  )

  const defaultTemplateName = settings.defaultTemplate
    ? templates.find((t) => t.id === settings.defaultTemplate)?.name
    : null

  if (isLoadingSettings) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="Journal" subtitle="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Journal" subtitle="Journal settings and preferences" />

      <SettingsGroup label="Default Template">
        <SettingRow label="Template" description="New entries start with this template">
          <Select
            value={settings.defaultTemplate ?? 'none'}
            onValueChange={handleTemplateChange}
            disabled={isLoadingTemplates || isLoadingSettings}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue placeholder="Select a template">
                {isLoadingSettings
                  ? 'Loading...'
                  : settings.defaultTemplate
                    ? (defaultTemplateName ?? 'Unknown template')
                    : 'None'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None (ask each time)</SelectItem>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  <span className="flex items-center gap-2">
                    {template.icon && <span>{template.icon}</span>}
                    {template.name}
                    {template.isBuiltIn && <Lock className="w-3 h-3 text-muted-foreground ml-1" />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Sidebar Visibility">
        <SettingRow label="Show Schedule" description="Display today's events and calendar">
          <Switch
            checked={settings.showSchedule}
            onCheckedChange={handleShowScheduleChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow label="Show Tasks" description="Display tasks due on the selected day">
          <Switch
            checked={settings.showTasks}
            onCheckedChange={handleShowTasksChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label="Show AI Connections"
          description="Display AI-powered connections to related entries"
        >
          <Switch
            checked={settings.showAIConnections}
            onCheckedChange={handleShowAIConnectionsChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Footer">
        <SettingRow label="Show Stats Footer" description="Word count, reading time, timestamps">
          <Switch
            checked={settings.showStatsFooter}
            onCheckedChange={handleShowStatsFooterChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
