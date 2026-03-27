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
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  SettingRowTall,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

export function EditorSettings() {
  const { settings, isLoading, updateSettings } = useEditorSettings()

  const handleWidthChange = useCallback(
    async (value: string) => {
      const success = await updateSettings({ width: value as 'narrow' | 'medium' | 'wide' })
      if (!success) toast.error('Failed to update editor width')
    },
    [updateSettings]
  )

  const handleToolbarModeChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateSettings({ toolbarMode: enabled ? 'sticky' : 'floating' })
      if (!success) toast.error('Failed to update toolbar mode')
    },
    [updateSettings]
  )

  const handleSpellCheckChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateSettings({ spellCheck: enabled })
      if (!success) toast.error('Failed to update spell check')
    },
    [updateSettings]
  )

  const handleAutoSaveDelayChange = useCallback(
    async (value: number[]) => {
      const success = await updateSettings({ autoSaveDelay: value[0] })
      if (!success) toast.error('Failed to update auto-save delay')
    },
    [updateSettings]
  )

  const handleWordCountChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateSettings({ showWordCount: enabled })
      if (!success) toast.error('Failed to update word count display')
    },
    [updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="Editor" subtitle="Loading settings..." />
      </div>
    )
  }

  const autoSaveSeconds = Math.round(settings.autoSaveDelay / 1000)

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Editor" subtitle="Note editor settings and preferences" />

      <SettingsGroup label="Layout">
        <SettingRow label="Editor Width" description="Maximum width of the writing area">
          <Select value={settings.width} onValueChange={handleWidthChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="narrow">Narrow</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="wide">Wide</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Toolbar">
        <SettingRow
          label="Sticky Formatting Toolbar"
          description="Always show toolbar above the editor"
        >
          <Switch
            checked={settings.toolbarMode === 'sticky'}
            onCheckedChange={handleToolbarModeChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Writing">
        <SettingRow label="Spell Check" description="Underline misspelled words while typing">
          <Switch
            checked={settings.spellCheck}
            onCheckedChange={handleSpellCheckChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRowTall
          label="Auto-Save Delay"
          description="Wait time after typing stops before saving"
        >
          <div className="flex items-center gap-3">
            <Slider
              min={0}
              max={30000}
              step={1000}
              value={[settings.autoSaveDelay]}
              onValueCommit={handleAutoSaveDelayChange}
              className="flex-1 max-w-xs"
            />
            <span className="text-xs/4 font-medium text-muted-foreground w-8 text-right shrink-0">
              {autoSaveSeconds === 0 ? '0s' : `${autoSaveSeconds}s`}
            </span>
          </div>
        </SettingRowTall>

        <SettingRow label="Word Count" description="Show word count in the editor footer">
          <Switch
            checked={settings.showWordCount}
            onCheckedChange={handleWordCountChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
