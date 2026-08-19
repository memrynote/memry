import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { useTasksContext } from '@/contexts/tasks'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

const SORT_OPTIONS = [
  { value: 'manual', labelKey: 'tasks.sortOrder.options.manual' },
  { value: 'dueDate', labelKey: 'tasks.sortOrder.options.dueDate' },
  { value: 'priority', labelKey: 'tasks.sortOrder.options.priority' },
  { value: 'createdAt', labelKey: 'tasks.sortOrder.options.createdAt' }
] as const

// Same order as the scope dropdown in the tasks toolbar.
const DEFAULT_VIEW_OPTIONS = [
  { value: 'all', labelKey: 'tasks.defaultView.options.all' },
  { value: 'today', labelKey: 'tasks.defaultView.options.today' },
  { value: 'tomorrow', labelKey: 'tasks.defaultView.options.tomorrow' },
  { value: 'next7', labelKey: 'tasks.defaultView.options.next7' }
] as const

export function TasksSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useTaskPreferences()
  const { projects } = useTasksContext()

  const activeProjects = projects.filter((p) => !p.isArchived)

  const handleDefaultProjectChange = useCallback(
    async (value: string) => {
      const projectId = value === 'none' ? null : value
      const success = await updateSettings({ defaultProjectId: projectId })
      if (!success) toast.error(t('tasks.defaultProject.error'))
    },
    [t, updateSettings]
  )

  const handleSortOrderChange = useCallback(
    async (value: string) => {
      const sortOrder = value as 'manual' | 'dueDate' | 'priority' | 'createdAt'
      const success = await updateSettings({ defaultSortOrder: sortOrder })
      if (!success) toast.error(t('tasks.sortOrder.error'))
    },
    [t, updateSettings]
  )

  const handleDefaultViewChange = useCallback(
    async (value: string) => {
      const defaultView = value as (typeof DEFAULT_VIEW_OPTIONS)[number]['value']
      const success = await updateSettings({ defaultView })
      if (!success) toast.error(t('tasks.defaultView.error'))
    },
    [t, updateSettings]
  )

  const handleStaleInboxChange = useCallback(
    async (value: string) => {
      const days = parseInt(value, 10)
      if (isNaN(days) || days < 1 || days > 90) return
      const success = await updateSettings({ staleInboxDays: days })
      if (!success) toast.error(t('tasks.staleInbox.error'))
    },
    [t, updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('tasks.header.title')} subtitle={t('tasks.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('tasks.header.title')} subtitle={t('tasks.header.subtitle')} />

      <SettingsGroup label={t('tasks.groups.defaults')}>
        <SettingRow
          label={t('tasks.defaultProject.label')}
          description={t('tasks.defaultProject.description')}
        >
          <Select
            value={settings.defaultProjectId ?? 'none'}
            onValueChange={(...args) => void handleDefaultProjectChange(...args)}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue placeholder={t('tasks.defaultProject.placeholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('tasks.defaultProject.none')}</SelectItem>
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

        <SettingRow
          label={t('tasks.sortOrder.label')}
          description={t('tasks.sortOrder.description')}
        >
          <Select
            value={settings.defaultSortOrder}
            onValueChange={(...args) => void handleSortOrderChange(...args)}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('tasks.defaultView.label')}
          description={t('tasks.defaultView.description')}
        >
          <Select
            value={settings.defaultView}
            onValueChange={(...args) => void handleDefaultViewChange(...args)}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEFAULT_VIEW_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('tasks.groups.inbox')}>
        <SettingRow
          label={t('tasks.staleInbox.label')}
          description={t('tasks.staleInbox.description')}
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
            <span className="text-xs/4 text-muted-foreground">{t('tasks.staleInbox.unit')}</span>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
