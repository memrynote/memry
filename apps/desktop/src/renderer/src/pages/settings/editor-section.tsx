import { useCallback } from 'react'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
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
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Editor</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  const autoSaveSeconds = Math.round(settings.autoSaveDelay / 1000)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Editor</h3>
        <p className="text-sm text-muted-foreground">Note editor settings and preferences</p>
      </div>

      <Separator />

      {/* Layout */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Layout
        </h4>

        <div className="space-y-2">
          <Label>Editor Width</Label>
          <p className="text-sm text-muted-foreground">
            Controls the maximum width of the writing area
          </p>
          <Select value={settings.width} onValueChange={handleWidthChange}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="narrow">Narrow</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="wide">Wide</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Separator />

      {/* Toolbar */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Toolbar
        </h4>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="sticky-toolbar">Sticky Formatting Toolbar</Label>
            <p className="text-sm text-muted-foreground">
              Always show the formatting toolbar above the editor instead of on text selection
            </p>
          </div>
          <Switch
            id="sticky-toolbar"
            checked={settings.toolbarMode === 'sticky'}
            onCheckedChange={handleToolbarModeChange}
          />
        </div>
      </div>

      <Separator />

      {/* Writing */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Writing
        </h4>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="spell-check">Spell Check</Label>
            <p className="text-sm text-muted-foreground">Underline misspelled words while typing</p>
          </div>
          <Switch
            id="spell-check"
            checked={settings.spellCheck}
            onCheckedChange={handleSpellCheckChange}
          />
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-Save Delay</Label>
              <p className="text-sm text-muted-foreground">
                How long to wait after typing stops before saving
              </p>
            </div>
            <span className="text-sm font-medium text-muted-foreground w-16 text-right">
              {autoSaveSeconds === 0 ? 'Instant' : `${autoSaveSeconds}s`}
            </span>
          </div>
          <Slider
            min={0}
            max={30000}
            step={1000}
            value={[settings.autoSaveDelay]}
            onValueCommit={handleAutoSaveDelayChange}
            className="max-w-xs"
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="word-count">Word Count</Label>
            <p className="text-sm text-muted-foreground">Show word count in the editor footer</p>
          </div>
          <Switch
            id="word-count"
            checked={settings.showWordCount}
            onCheckedChange={handleWordCountChange}
          />
        </div>
      </div>
    </div>
  )
}
