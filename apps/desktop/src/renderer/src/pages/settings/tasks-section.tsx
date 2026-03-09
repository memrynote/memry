import { useCallback } from 'react'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { useTasksContext } from '@/contexts/tasks'
import { toast } from 'sonner'

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
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Tasks</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Tasks</h3>
        <p className="text-sm text-muted-foreground">Configure task defaults and behavior</p>
      </div>

      <Separator />

      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Defaults
        </h4>

        <div className="space-y-2">
          <Label>Default Project</Label>
          <p className="text-sm text-muted-foreground">
            New tasks are assigned to this project when no project is explicitly selected
          </p>
          <Select
            value={settings.defaultProjectId ?? 'none'}
            onValueChange={handleDefaultProjectChange}
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="No default project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No default (use Personal)</SelectItem>
              {activeProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Default Sort Order</Label>
          <p className="text-sm text-muted-foreground">
            How tasks are ordered by default in list view
          </p>
          <Select value={settings.defaultSortOrder} onValueChange={handleSortOrderChange}>
            <SelectTrigger className="w-full max-w-xs">
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
        </div>
      </div>

      <Separator />

      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Calendar
        </h4>

        <div className="space-y-2">
          <Label>Week Starts On</Label>
          <p className="text-sm text-muted-foreground">
            First day of the week in calendar and date views
          </p>
          <ToggleGroup
            type="single"
            value={settings.weekStartDay}
            onValueChange={handleWeekStartChange}
            className="justify-start"
          >
            <ToggleGroupItem value="sunday" aria-label="Sunday" className="px-4">
              Sunday
            </ToggleGroupItem>
            <ToggleGroupItem value="monday" aria-label="Monday" className="px-4">
              Monday
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <Separator />

      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Inbox
        </h4>

        <div className="space-y-2">
          <Label htmlFor="stale-inbox-days">Stale Inbox Threshold (days)</Label>
          <p className="text-sm text-muted-foreground">
            Tasks in the inbox older than this are highlighted as stale
          </p>
          <Input
            id="stale-inbox-days"
            type="number"
            min={1}
            max={90}
            value={settings.staleInboxDays}
            onChange={(e) => void handleStaleInboxChange(e.target.value)}
            className="w-24"
          />
        </div>
      </div>
    </div>
  )
}
