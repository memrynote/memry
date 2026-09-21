import { useCallback } from 'react'

import { useT } from '@memry/i18n/renderer'
import {
  Layers,
  ArrowUp,
  ArrowDown,
  Flag,
  CircleDashed,
  Calendar,
  Clock,
  Type,
  FileText,
  Folder,
  FolderOpen,
  CheckCircle
} from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { TaskSort, SortField, SortDirection } from '@/data/tasks-data'
import { defaultSort } from '@/data/tasks-data'

interface GroupByDropdownProps {
  sort: TaskSort
  onChange: (sort: TaskSort) => void
  className?: string
}

const GROUP_FIELD_ICONS: Record<SortField, React.ComponentType<{ size?: number }>> = {
  dueDate: Calendar,
  priority: Flag,
  status: CircleDashed,
  createdAt: Clock,
  title: Type,
  project: Folder,
  completedAt: CheckCircle,
  folder: FolderOpen,
  note: FileText
}

const VISIBLE_FIELDS: SortField[] = [
  'priority',
  'status',
  'dueDate',
  'createdAt',
  'title',
  'project',
  'folder',
  'note'
]

export const GroupByDropdown = ({
  sort,
  onChange,
  className
}: GroupByDropdownProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const isNonDefault = sort.field !== defaultSort.field || sort.direction !== defaultSort.direction

  // Written out key by key so the i18n scanner can see every one of them; a
  // lookup table of key strings would only register as a dynamic key.
  const fieldLabels: Record<SortField, string> = {
    dueDate: t('filters.groupByFields.dueDate'),
    priority: t('filters.groupByFields.priority'),
    status: t('filters.groupByFields.status'),
    createdAt: t('filters.groupByFields.createdAt'),
    title: t('filters.groupByFields.title'),
    project: t('filters.groupByFields.project'),
    completedAt: t('filters.groupByFields.completedAt'),
    folder: t('filters.groupByFields.folder'),
    note: t('filters.groupByFields.note')
  }

  const handleSelectField = useCallback(
    (field: string) => {
      onChange({ ...sort, field: field as SortField })
    },
    [sort, onChange]
  )

  const handleSetDirection = useCallback(
    (direction: SortDirection) => {
      onChange({ ...sort, direction })
    },
    [sort, onChange]
  )

  return (
    <Picker value={sort.field} onValueChange={handleSelectField} closeOnSelect={false}>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <Picker.Trigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('filters.groupByOptions')}
                className={cn(
                  'flex items-center justify-center shrink-0 rounded-[5px] p-1.5 transition-colors',
                  isNonDefault
                    ? 'bg-foreground/5 text-foreground/90'
                    : 'text-muted-foreground hover:bg-surface-active/50',
                  className
                )}
              >
                <Layers size={14} />
              </button>
            </TooltipTrigger>
          </Picker.Trigger>
          <TooltipContent side="bottom">{t('filters.groupBy')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Picker.Content width="auto" align="end" sideOffset={8}>
        <Picker.List>
          {VISIBLE_FIELDS.map((field) => {
            const Icon = GROUP_FIELD_ICONS[field]
            return (
              <Picker.Item
                key={field}
                value={field}
                label={fieldLabels[field]}
                icon={<Icon size={14} />}
                indicator="check"
                indicatorColor="var(--primary)"
              />
            )
          })}
        </Picker.List>
        <Picker.Footer>
          <div className="p-1">
            <div className="flex items-center justify-between rounded-[5px] py-1.5 px-2">
              <span className="text-[13px] text-muted-foreground leading-4">
                {sort.direction === 'asc'
                  ? t('filters.sortDirectionAscending')
                  : t('filters.sortDirectionDescending')}
              </span>
              <div className="flex items-center rounded-sm overflow-clip border border-border">
                <button
                  type="button"
                  aria-label={t('filters.sortAscending')}
                  onClick={() => handleSetDirection('asc')}
                  className={cn(
                    'flex items-center justify-center w-[22px] h-5 shrink-0 transition-colors',
                    sort.direction === 'asc' ? 'bg-foreground/8' : 'hover:bg-foreground/5'
                  )}
                >
                  <ArrowUp
                    size={10}
                    style={{
                      color: sort.direction === 'asc' ? 'var(--foreground)' : 'var(--text-tertiary)'
                    }}
                  />
                </button>
                <button
                  type="button"
                  aria-label={t('filters.sortDescending')}
                  onClick={() => handleSetDirection('desc')}
                  className={cn(
                    'flex items-center justify-center w-[22px] h-5 shrink-0 transition-colors',
                    sort.direction === 'desc' ? 'bg-foreground/8' : 'hover:bg-foreground/5'
                  )}
                >
                  <ArrowDown
                    size={10}
                    style={{
                      color:
                        sort.direction === 'desc' ? 'var(--foreground)' : 'var(--text-tertiary)'
                    }}
                  />
                </button>
              </div>
            </div>
          </div>
        </Picker.Footer>
      </Picker.Content>
    </Picker>
  )
}

export default GroupByDropdown
