import { useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useEditorSettings } from '@/hooks/use-editor-settings'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

export function EditorSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useEditorSettings()

  const handleWidthChange = useCallback(
    async (value: string) => {
      const success = await updateSettings({ width: value as 'normal' | 'full' })
      if (!success) toast.error(t('editor.width.error'))
    },
    [t, updateSettings]
  )

  const handleToolbarModeChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateSettings({ toolbarMode: enabled ? 'sticky' : 'floating' })
      if (!success) toast.error(t('editor.toolbarMode.error'))
    },
    [t, updateSettings]
  )

  const handleSpellCheckChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateSettings({ spellCheck: enabled })
      if (!success) toast.error(t('editor.spellCheck.error'))
    },
    [t, updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('editor.header.title')} subtitle={t('editor.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('editor.header.title')} subtitle={t('editor.header.subtitle')} />

      <SettingsGroup label={t('editor.groups.layout')}>
        <SettingRow label={t('editor.width.label')} description={t('editor.width.description')}>
          <Select
            value={settings.width}
            onValueChange={(...args) => void handleWidthChange(...args)}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">{t('editor.width.options.normal')}</SelectItem>
              <SelectItem value="full">{t('editor.width.options.full')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('editor.groups.toolbar')}>
        <SettingRow
          label={t('editor.toolbarMode.label')}
          description={t('editor.toolbarMode.description')}
        >
          <Switch
            checked={settings.toolbarMode === 'sticky'}
            onCheckedChange={(...args) => void handleToolbarModeChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('editor.groups.spelling')}>
        <SettingRow
          label={t('editor.spellCheck.label')}
          description={t('editor.spellCheck.description')}
        >
          <Switch
            checked={settings.spellCheck}
            onCheckedChange={(...args) => void handleSpellCheckChange(...args)}
            aria-label={t('editor.spellCheck.label')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
