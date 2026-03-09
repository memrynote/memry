import { useCallback } from 'react'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Info, Lock } from 'lucide-react'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { toast } from 'sonner'

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
      if (success) {
        toast.success(checked ? 'Schedule section shown' : 'Schedule section hidden')
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateSettings]
  )

  const handleShowTasksChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showTasks: checked })
      if (success) {
        toast.success(checked ? 'Tasks section shown' : 'Tasks section hidden')
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateSettings]
  )

  const handleShowAIConnectionsChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showAIConnections: checked })
      if (success) {
        toast.success(checked ? 'AI Connections shown' : 'AI Connections hidden')
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateSettings]
  )

  const handleShowStatsFooterChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showStatsFooter: checked })
      if (success) {
        toast.success(checked ? 'Stats footer shown' : 'Stats footer hidden')
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateSettings]
  )

  const defaultTemplateName = settings.defaultTemplate
    ? templates.find((t) => t.id === settings.defaultTemplate)?.name
    : null

  if (isLoadingSettings) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Journal</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Journal</h3>
        <p className="text-sm text-muted-foreground">Journal settings and preferences</p>
      </div>

      <Separator />

      {/* Default Template Setting */}
      <div className="space-y-4">
        <div>
          <label htmlFor="default-template" className="text-sm font-medium">
            Default Template
          </label>
          <p className="text-sm text-muted-foreground mt-1">
            New journal entries will start with this template. You can always change it when
            creating an entry.
          </p>
        </div>

        <Select
          value={settings.defaultTemplate ?? 'none'}
          onValueChange={handleTemplateChange}
          disabled={isLoadingTemplates || isLoadingSettings}
        >
          <SelectTrigger id="default-template" className="w-full max-w-xs">
            <SelectValue placeholder="Select a template">
              {isLoadingSettings
                ? 'Loading...'
                : settings.defaultTemplate
                  ? (defaultTemplateName ?? 'Unknown template')
                  : 'None (ask each time)'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <span className="flex items-center gap-2">None (ask each time)</span>
            </SelectItem>
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

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            When a default template is set, new journal entries will be created with the template
            content automatically. A small indicator will appear letting you change the template or
            start blank.
          </p>
        </div>
      </div>

      <Separator />

      {/* Sidebar Visibility Section */}
      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Sidebar Visibility
          </h4>
          <p className="text-sm text-muted-foreground mt-1">
            Choose which sections to display in the journal sidebar. The calendar is always visible.
          </p>
        </div>

        {/* Show Schedule Toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-schedule">Show Schedule</Label>
            <p className="text-sm text-muted-foreground">
              Display today's events and calendar schedule
            </p>
          </div>
          <Switch
            id="show-schedule"
            checked={settings.showSchedule}
            onCheckedChange={handleShowScheduleChange}
          />
        </div>

        {/* Show Tasks Toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-tasks">Show Tasks</Label>
            <p className="text-sm text-muted-foreground">Display tasks due on the selected day</p>
          </div>
          <Switch
            id="show-tasks"
            checked={settings.showTasks}
            onCheckedChange={handleShowTasksChange}
          />
        </div>

        {/* Show AI Connections Toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-ai-connections">Show AI Connections</Label>
            <p className="text-sm text-muted-foreground">
              Display AI-powered connections to related entries and notes
            </p>
          </div>
          <Switch
            id="show-ai-connections"
            checked={settings.showAIConnections}
            onCheckedChange={handleShowAIConnectionsChange}
          />
        </div>

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            The mini calendar at the top of the sidebar is always visible for quick navigation.
            These settings only affect the additional panels below it.
          </p>
        </div>
      </div>

      <Separator />

      {/* Footer Section */}
      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Footer
          </h4>
          <p className="text-sm text-muted-foreground mt-1">
            Display document statistics at the bottom of journal entries.
          </p>
        </div>

        {/* Show Stats Footer Toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-stats-footer">Show Stats Footer</Label>
            <p className="text-sm text-muted-foreground">
              Display word count, reading time, and timestamps at the bottom
            </p>
          </div>
          <Switch
            id="show-stats-footer"
            checked={settings.showStatsFooter}
            onCheckedChange={handleShowStatsFooterChange}
          />
        </div>
      </div>
    </div>
  )
}
