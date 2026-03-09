import { useCallback } from 'react'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Info } from 'lucide-react'
import { useNoteEditorSettings } from '@/hooks/use-note-editor-settings'
import { toast } from 'sonner'

export function EditorSettings() {
  const { settings, isLoading, setToolbarMode } = useNoteEditorSettings()

  const handleToolbarModeChange = useCallback(
    async (enabled: boolean) => {
      const newMode = enabled ? 'sticky' : 'floating'
      const success = await setToolbarMode(newMode)
      if (success) {
        toast.success(
          enabled ? 'Sticky toolbar enabled' : 'Floating toolbar enabled (shows on text selection)'
        )
      } else {
        toast.error('Failed to update setting')
      }
    },
    [setToolbarMode]
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Editor</h3>
        <p className="text-sm text-muted-foreground">Note editor settings and preferences</p>
      </div>

      <Separator />

      {/* Toolbar Mode Section */}
      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Toolbar
          </h4>
        </div>

        {/* Sticky Toolbar Toggle */}
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

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            When disabled (floating mode), the formatting toolbar appears only when you select text.
            Enable sticky mode to always have quick access to Bold, Italic, and other formatting
            options.
          </p>
        </div>
      </div>
    </div>
  )
}
