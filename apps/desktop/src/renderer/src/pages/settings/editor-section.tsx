import { useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
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
  SettingRowTall,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

export function EditorSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useEditorSettings()

  const handleWidthChange = useCallback(
    async (value: string) => {
      const success = await updateSettings({ width: value as 'narrow' | 'medium' | 'wide' })
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

  const handleAutoSaveDelayChange = useCallback(
    async (value: number[]) => {
      const success = await updateSettings({ autoSaveDelay: value[0] })
      if (!success) toast.error(t('editor.autoSaveDelay.error'))
    },
    [t, updateSettings]
  )

  const handleWordCountChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateSettings({ showWordCount: enabled })
      if (!success) toast.error(t('editor.wordCount.error'))
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

  const autoSaveSeconds = Math.round(settings.autoSaveDelay / 1000)

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
              <SelectItem value="narrow">{t('editor.width.options.narrow')}</SelectItem>
              <SelectItem value="medium">{t('editor.width.options.medium')}</SelectItem>
              <SelectItem value="wide">{t('editor.width.options.wide')}</SelectItem>
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

      <SettingsGroup label={t('editor.groups.writing')}>
        <SettingRow
          label={t('editor.spellCheck.label')}
          description={t('editor.spellCheck.description')}
        >
          <Switch
            checked={settings.spellCheck}
            onCheckedChange={(...args) => void handleSpellCheckChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRowTall
          label={t('editor.autoSaveDelay.label')}
          description={t('editor.autoSaveDelay.description')}
        >
          <div className="flex items-center gap-3">
            <Slider
              min={0}
              max={30000}
              step={1000}
              value={[settings.autoSaveDelay]}
              onValueCommit={(...args) => void handleAutoSaveDelayChange(...args)}
              className="flex-1 max-w-xs"
            />
            <span className="text-xs/4 font-medium text-muted-foreground w-8 text-end shrink-0">
              {t('editor.autoSaveDelay.seconds', { seconds: autoSaveSeconds })}
            </span>
          </div>
        </SettingRowTall>

        <SettingRow
          label={t('editor.wordCount.label')}
          description={t('editor.wordCount.description')}
        >
          <Switch
            checked={settings.showWordCount}
            onCheckedChange={(...args) => void handleWordCountChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
