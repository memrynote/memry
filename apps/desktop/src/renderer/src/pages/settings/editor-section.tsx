import { useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useEditorSettings } from '@/hooks/use-editor-settings'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'

const SEGMENT_ITEM =
  'h-auto min-w-0 rounded-[5px] border-none py-0.75 px-2.5 text-xs/4 text-muted-foreground shadow-none hover:bg-transparent data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]'

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
        <SettingRow label={t('editor.v2.width')} description={t('editor.width.description')}>
          <ToggleGroup
            type="single"
            value={settings.width}
            onValueChange={(value) => {
              if (value) void handleWidthChange(value)
            }}
            aria-label={t('editor.v2.width')}
            className="gap-0 rounded-[7px] bg-muted p-0.5"
          >
            <ToggleGroupItem value="normal" className={SEGMENT_ITEM}>
              {t('editor.width.options.normal')}
            </ToggleGroupItem>
            <ToggleGroupItem value="full" className={SEGMENT_ITEM}>
              {t('editor.width.options.full')}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>

        <SettingRow
          label={t('editor.v2.toolbarMode')}
          description={t('editor.toolbarMode.description')}
        >
          <Switch
            checked={settings.toolbarMode === 'sticky'}
            onCheckedChange={(...args) => void handleToolbarModeChange(...args)}
            aria-label={t('editor.v2.toolbarMode')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('editor.groups.spelling')}>
        <SettingRow
          label={t('editor.v2.spellCheck')}
          description={t('editor.spellCheck.description')}
        >
          <Switch
            checked={settings.spellCheck}
            onCheckedChange={(...args) => void handleSpellCheckChange(...args)}
            aria-label={t('editor.v2.spellCheck')}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
