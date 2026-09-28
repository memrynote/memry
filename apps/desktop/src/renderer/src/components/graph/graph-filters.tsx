import type { Dispatch } from 'react'
import { FileText, FolderOpen, PenTool, Tag, Unlink, X, Undo, Focus } from '@/lib/icons'
import { PageJournalIcon, PageTasksIcon } from '@/lib/icons/page-icons'
import { Toggle } from '@/components/ui/toggle'
import { Button } from '@/components/ui/button'
import type { GraphFilterState, GraphFilterAction } from '@/hooks/use-graph-filters'
import { useT } from '@memry/i18n/renderer'

interface GraphFiltersProps {
  filterState: GraphFilterState
  dispatch: Dispatch<GraphFilterAction>
  isFiltered: boolean
  focusLabel: string | null
}

const ENTITY_TOGGLES = [
  {
    type: 'note' as const,
    icon: FileText,
    labelKey: 'filter.notes',
    colorClass: 'text-[var(--graph-node-note)]'
  },
  {
    type: 'journal' as const,
    icon: PageJournalIcon,
    labelKey: 'filter.journals',
    colorClass: 'text-[var(--graph-node-journal)]'
  },
  {
    type: 'task' as const,
    icon: PageTasksIcon,
    labelKey: 'filter.tasks',
    colorClass: 'text-[var(--graph-node-task)]'
  },
  {
    type: 'project' as const,
    icon: FolderOpen,
    labelKey: 'filter.projects',
    colorClass: 'text-[var(--graph-node-project)]'
  },
  {
    type: 'tag' as const,
    icon: Tag,
    labelKey: 'filter.tags',
    colorClass: 'text-[var(--graph-node-tag)]'
  }
] as const

const TYPE_TO_STATE_KEY: Record<string, keyof GraphFilterState> = {
  note: 'showNotes',
  journal: 'showJournals',
  task: 'showTasks',
  project: 'showProjects',
  tag: 'showTags'
}

export function GraphFilters({
  filterState,
  dispatch,
  isFiltered,
  focusLabel
}: GraphFiltersProps): React.JSX.Element {
  const { t } = useT('graph')

  return (
    <div className="absolute start-3 top-3 z-40 flex flex-col gap-2">
      <div className="rounded-md border border-border bg-popover/95 backdrop-blur-sm p-2 shadow-card">
        <div className="flex items-center gap-1">
          {ENTITY_TOGGLES.map(({ type, icon: Icon, labelKey, colorClass }) => {
            const label = t(labelKey)
            return (
              <Toggle
                key={type}
                size="sm"
                pressed={filterState[TYPE_TO_STATE_KEY[type]] as boolean}
                onPressedChange={() => dispatch({ type: 'TOGGLE_ENTITY_TYPE', entityType: type })}
                aria-label={t('filter.toggle-entity', { label })}
              >
                <Icon
                  className={`size-3.5 ${filterState[TYPE_TO_STATE_KEY[type]] ? colorClass : 'text-muted-foreground/40'}`}
                />
              </Toggle>
            )
          })}

          <div className="w-px h-5 bg-border mx-0.5" />

          <Toggle
            size="sm"
            pressed={filterState.showOrphans}
            onPressedChange={() => dispatch({ type: 'TOGGLE_ORPHANS' })}
            aria-label={t('filter.toggle-orphans')}
          >
            <Unlink
              className={`size-3.5 ${filterState.showOrphans ? 'text-muted-foreground' : 'text-muted-foreground/40'}`}
            />
          </Toggle>

          <Toggle
            size="sm"
            pressed={filterState.showCanvasEdges}
            onPressedChange={() => dispatch({ type: 'TOGGLE_CANVAS_EDGES' })}
            aria-label={t('filter.toggle-canvas-edges')}
          >
            <PenTool
              className={`size-3.5 ${filterState.showCanvasEdges ? 'text-[var(--graph-edge-canvas)]' : 'text-muted-foreground/40'}`}
            />
          </Toggle>

          {isFiltered && (
            <>
              <div className="w-px h-5 bg-border mx-0.5" />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-1.5"
                onClick={() => dispatch({ type: 'RESET_FILTERS' })}
                aria-label={t('control.reset-filters')}
              >
                <Undo className="size-3.5 text-muted-foreground" />
              </Button>
            </>
          )}
        </div>
      </div>

      {filterState.focusNodeId && focusLabel && (
        <div className="rounded-md border border-border bg-popover/95 backdrop-blur-sm px-2.5 py-1.5 shadow-card flex items-center gap-2">
          <Focus className="size-3.5 text-accent-cyan shrink-0" />
          <span className="text-xs text-foreground truncate max-w-[140px]">{focusLabel}</span>
          <span className="text-[10px] text-muted-foreground">
            {t('control.focus-depth', { depth: filterState.focusDepth })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 ms-auto"
            onClick={() => dispatch({ type: 'CLEAR_FOCUS' })}
            aria-label={t('control.clear-focus')}
          >
            <X className="size-3 text-muted-foreground" />
          </Button>
        </div>
      )}
    </div>
  )
}
