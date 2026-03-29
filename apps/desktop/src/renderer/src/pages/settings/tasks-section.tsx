import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { useTasksContext } from '@/contexts/tasks'
import { toast } from 'sonner'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

const SORT_OPTIONS = [
  { value: 'manual', label: 'Manual (drag & drop)' },
  { value: 'dueDate', label: 'Due Date' },
  { value: 'priority', label: 'Priority' },
  { value: 'createdAt', label: 'Date Created' }
] as const

export function TasksSettings() {
  const { settings, isLoading, updateSettings } = useTaskPreferences()
  const { projects } = useTasksContext()

  const activeProjects = projects.filter((p) => !p.isArchived)

  const handleDefaultProjectChange = useCallback(
    async (value: string) => {
      const projectId = value === 'none' ? null : value
      const success = await updateSettings({ defaultProjectId: projectId })
      if (!success) toast.error('Failed to update default project')
    },
    [updateSettings]
  )

  const handleSortOrderChange = useCallback(
    async (value: string) => {
      const sortOrder = value as 'manual' | 'dueDate' | 'priority' | 'createdAt'
      const success = await updateSettings({ defaultSortOrder: sortOrder })
      if (!success) toast.error('Failed to update sort order')
    },
    [updateSettings]
  )

  const handleWeekStartChange = useCallback(
    async (value: string) => {
      if (!value) return
      const weekStart = value as 'sunday' | 'monday'
      const success = await updateSettings({ weekStartDay: weekStart })
      if (!success) toast.error('Failed to update week start')
    },
    [updateSettings]
  )

  const handleStaleInboxChange = useCallback(
    async (value: string) => {
      const days = parseInt(value, 10)
      if (isNaN(days) || days < 1 || days > 90) return
      const success = await updateSettings({ staleInboxDays: days })
      if (!success) toast.error('Failed to update stale inbox threshold')
    },
    [updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="Tasks" subtitle="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Tasks" subtitle="Configure task defaults and behavior" />

      <SettingsGroup label="Defaults">
        <SettingRow label="Default Project" description="Assigned when no project is selected">
          <Select
            value={settings.defaultProjectId ?? 'none'}
            onValueChange={handleDefaultProjectChange}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue placeholder="No default project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No default (use Personal)</SelectItem>
              {activeProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label="Default Sort Order" description="How tasks are ordered in list view">
          <Select value={settings.defaultSortOrder} onValueChange={handleSortOrderChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Calendar">
        <SettingRow label="Week Starts On" description="First day of the week in calendar views">
          <ToggleGroup
            type="single"
            value={settings.weekStartDay}
            onValueChange={handleWeekStartChange}
            className="gap-0 rounded-md border border-border overflow-clip"
          >
            <ToggleGroupItem
              value="sunday"
              aria-label="Sunday"
              className="rounded-none border-none px-3 h-7 text-xs/4 font-medium data-[state=on]:bg-[var(--tint)] data-[state=on]:text-white"
            >
              Sunday
            </ToggleGroupItem>
            <ToggleGroupItem
              value="monday"
              aria-label="Monday"
              className="rounded-none border-none border-l border-border px-3 h-7 text-xs/4 font-medium data-[state=on]:bg-[var(--tint)] data-[state=on]:text-white"
            >
              Monday
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Inbox">
        <SettingRow
          label="Stale Inbox Threshold"
          description="Tasks older than this are highlighted as stale"
        >
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              max={90}
              value={settings.staleInboxDays}
              onChange={(e) => void handleStaleInboxChange(e.target.value)}
              className="w-14 h-7 text-center text-xs/4 px-2"
            />
            <span className="text-xs/4 text-muted-foreground">days</span>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
