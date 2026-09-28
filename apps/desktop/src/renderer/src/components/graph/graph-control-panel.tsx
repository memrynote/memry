import { type Dispatch, useRef, useEffect, useState } from 'react'
import {
  Search,
  X,
  Undo,
  ChevronRight,
  Focus,
  FileText,
  FolderOpen,
  PenTool,
  Tag,
  Unlink,
  Settings,
  RotateCcw,
  Expand,
  Shrink
} from '@/lib/icons'
import { PageJournalIcon, PageTasksIcon } from '@/lib/icons/page-icons'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import type { GraphFilterState, GraphFilterAction } from '@/hooks/use-graph-filters'
import type { GraphColorBy, GraphSettings } from '@memry/contracts/graph-api'
import { GRAPH_GROUP_NONE_VAR, type GraphCategory } from '@/lib/graph-categories'
import { useT } from '@memry/i18n/renderer'

export interface GraphCategoryRow extends GraphCategory {
  /** Notes, journals, tasks and projects that fall in this category. */
  count: number
}

interface GraphControlPanelProps {
  filterState: GraphFilterState
  dispatch: Dispatch<GraphFilterAction>
  isFiltered: boolean
  focusLabel: string | null
  settings: GraphSettings
  updateSettings: (updates: Partial<GraphSettings>) => void
  /** Forget the saved arrangement and pins, and lay the graph out from scratch. */
  onRelayout?: () => Promise<void> | void
  /** The saved-views switcher, rendered at the top of the drawer. */
  viewsMenu?: React.ReactNode
  colorBy?: GraphColorBy
  onColorByChange?: (colorBy: GraphColorBy) => void
  categories?: GraphCategoryRow[]
  collapsedCategoryIds?: readonly string[]
  onToggleCategory?: (categoryId: string) => void
}

const ENTITY_FILTERS = [
  {
    key: 'showNotes' as const,
    labelKey: 'filter.notes',
    icon: FileText,
    colorVar: '--graph-node-note'
  },
  {
    key: 'showJournals' as const,
    labelKey: 'filter.journals',
    icon: PageJournalIcon,
    colorVar: '--graph-node-journal'
  },
  {
    key: 'showTasks' as const,
    labelKey: 'filter.tasks',
    icon: PageTasksIcon,
    colorVar: '--graph-node-task'
  },
  {
    key: 'showProjects' as const,
    labelKey: 'filter.projects',
    icon: FolderOpen,
    colorVar: '--graph-node-project'
  },
  { key: 'showTags' as const, labelKey: 'filter.tags', icon: Tag, colorVar: '--graph-node-tag' },
  { key: 'showOrphans' as const, labelKey: 'filter.orphans', icon: Unlink, colorVar: null }
] as const

const KEY_TO_ENTITY: Record<string, 'note' | 'task' | 'journal' | 'project' | 'tag'> = {
  showNotes: 'note',
  showJournals: 'journal',
  showTasks: 'task',
  showProjects: 'project',
  showTags: 'tag'
}

export function GraphControlPanel({
  filterState,
  dispatch,
  isFiltered,
  focusLabel,
  settings,
  updateSettings,
  onRelayout,
  viewsMenu,
  colorBy = 'type',
  onColorByChange,
  categories,
  collapsedCategoryIds = [],
  onToggleCategory
}: GraphControlPanelProps): React.JSX.Element {
  const { t } = useT('graph')
  const [isOpen, setIsOpen] = useState(false)
  const [confirmRelayout, setConfirmRelayout] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setIsOpen(true)
        inputRef.current?.focus()
      }
      if (e.key === 'Escape' && filterState.searchQuery) {
        dispatch({ type: 'SET_SEARCH_QUERY', query: '' })
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [filterState.searchQuery, dispatch])

  return (
    <>
      {/* Gear toggle — always visible */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="absolute end-3 top-3 z-50 flex size-8 items-center justify-center rounded-md border border-border bg-popover/95 backdrop-blur-sm shadow-card transition-colors hover:bg-accent"
        title={isOpen ? t('control.hide-settings') : t('control.show-settings')}
      >
        <Settings
          className={`size-4 text-muted-foreground transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Sliding drawer */}
      <div
        className={`absolute end-0 top-0 z-40 w-[260px] max-h-full border-s border-border bg-popover/95 backdrop-blur-sm rounded-bl-lg overflow-y-auto transition-transform duration-250 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="p-3 space-y-0.5">
          {viewsMenu && <div className="pe-10 pb-2">{viewsMenu}</div>}

          {isFiltered && (
            <div className="flex justify-end mb-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => dispatch({ type: 'RESET_FILTERS' })}
                title={t('control.reset-filters')}
                aria-label={t('control.reset-filters')}
              >
                <Undo className="size-3 text-muted-foreground" />
              </Button>
            </div>
          )}

          {/* Focus indicator */}
          {filterState.focusNodeId && focusLabel && (
            <div className="rounded-md border border-accent-cyan/30 bg-accent-cyan/5 px-2.5 py-1.5 mb-2 flex items-center gap-2">
              <Focus className="size-3.5 text-accent-cyan shrink-0" />
              <span className="text-xs text-foreground truncate">{focusLabel}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {t('control.focus-depth', { depth: filterState.focusDepth })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 ms-auto shrink-0"
                onClick={() => dispatch({ type: 'CLEAR_FOCUS' })}
                aria-label={t('control.clear-focus')}
              >
                <X className="size-3 text-muted-foreground" />
              </Button>
            </div>
          )}

          {/* Filters section */}
          <PanelSection title={t('control.filters')} defaultOpen>
            <div className="space-y-2.5">
              <div className="relative">
                <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  ref={inputRef}
                  placeholder={t('search.placeholder')}
                  className="h-8 ps-8 pe-8 text-xs bg-background border-border"
                  value={filterState.searchQuery}
                  onChange={(e) => dispatch({ type: 'SET_SEARCH_QUERY', query: e.target.value })}
                />
                {filterState.searchQuery && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute end-1 top-1/2 -translate-y-1/2 h-5 w-5 p-0"
                    onClick={() => dispatch({ type: 'SET_SEARCH_QUERY', query: '' })}
                    aria-label={t('search.clear')}
                  >
                    <X className="size-3 text-muted-foreground" />
                  </Button>
                )}
              </div>

              {ENTITY_FILTERS.map(({ key, labelKey, icon: Icon, colorVar }) => {
                const isOrphan = key === 'showOrphans'
                const checked = isOrphan ? filterState.showOrphans : filterState[key]
                const label = t(labelKey)
                return (
                  <div key={key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon
                        className="size-3.5"
                        style={colorVar ? { color: `var(${colorVar})` } : undefined}
                      />
                      <Label className="text-xs text-foreground font-normal">{label}</Label>
                    </div>
                    <Switch
                      checked={checked}
                      onCheckedChange={() => {
                        if (isOrphan) {
                          dispatch({ type: 'TOGGLE_ORPHANS' })
                        } else {
                          dispatch({ type: 'TOGGLE_ENTITY_TYPE', entityType: KEY_TO_ENTITY[key] })
                        }
                      }}
                    />
                  </div>
                )
              })}

              {/* Edges, not nodes: arrows drawn between cards on a canvas. */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <PenTool className="size-3.5" style={{ color: 'var(--graph-edge-canvas)' }} />
                  <Label className="text-xs text-foreground font-normal">
                    {t('filter.canvas-edges')}
                  </Label>
                </div>
                <Switch
                  checked={filterState.showCanvasEdges}
                  onCheckedChange={() => dispatch({ type: 'TOGGLE_CANVAS_EDGES' })}
                  aria-label={t('filter.canvas-edges')}
                />
              </div>
            </div>
          </PanelSection>

          {/* Categories section: colour legend and collapse controls */}
          {categories && onColorByChange && onToggleCategory && (
            <PanelSection title={t('control.categories')} defaultOpen>
              <div className="space-y-2.5">
                <FilterSwitch
                  label={t('control.color-by-category')}
                  checked={colorBy === 'tag-category'}
                  onCheckedChange={(v) => onColorByChange(v ? 'tag-category' : 'type')}
                />
                {categories.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t('control.no-categories')}
                  </p>
                ) : (
                  <ul className="space-y-1" aria-label={t('control.categories')}>
                    {categories.map((category) => {
                      const collapsed = collapsedCategoryIds.includes(category.id)
                      const actionLabel = collapsed
                        ? t('control.expand-category', { name: category.label })
                        : t('control.collapse-category', { name: category.label })
                      return (
                        <li key={category.id} className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: `var(${category.colorVar})` }}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                            {category.label}
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {category.count}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 shrink-0 p-0"
                            onClick={() => onToggleCategory(category.id)}
                            disabled={!collapsed && category.count === 0}
                            aria-pressed={collapsed}
                            aria-label={actionLabel}
                            title={actionLabel}
                          >
                            {collapsed ? (
                              <Expand className="size-3 text-foreground" />
                            ) : (
                              <Shrink className="size-3 text-muted-foreground" />
                            )}
                          </Button>
                        </li>
                      )
                    })}
                    {colorBy === 'tag-category' && (
                      <li className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: `var(${GRAPH_GROUP_NONE_VAR})` }}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {t('control.uncategorized')}
                        </span>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </PanelSection>
          )}

          {/* Display section */}
          <PanelSection title={t('control.display')} defaultOpen>
            <div className="space-y-3">
              <FilterSwitch
                label={t('control.show-labels')}
                checked={settings.showLabels}
                onCheckedChange={(v) => updateSettings({ showLabels: v })}
              />
              <FilterSwitch
                label={t('control.live-motion')}
                checked={settings.animateLayout}
                onCheckedChange={(v) => updateSettings({ animateLayout: v })}
              />
              {onRelayout && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-full justify-start gap-2 text-xs"
                  onClick={() => setConfirmRelayout(true)}
                >
                  <RotateCcw className="size-3.5 text-muted-foreground" />
                  {t('control.relayout')}
                </Button>
              )}
            </div>
          </PanelSection>
        </div>
      </div>

      {onRelayout && (
        <AlertDialog open={confirmRelayout} onOpenChange={setConfirmRelayout}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('relayout-confirm.title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('relayout-confirm.description')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('relayout-confirm.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onRelayout()}>
                {t('relayout-confirm.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}

function PanelSection({
  title,
  defaultOpen = true,
  children
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full py-2 group">
        <ChevronRight
          className={`size-3 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[11px] font-medium text-foreground">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-2 ps-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function FilterSwitch({
  label,
  checked,
  onCheckedChange
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs text-foreground font-normal">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
