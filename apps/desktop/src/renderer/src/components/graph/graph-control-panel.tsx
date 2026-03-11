import { type Dispatch, useRef, useEffect, useState } from 'react'
import {
  Search,
  X,
  RotateCcw,
  ChevronRight,
  Focus,
  FileText,
  BookOpen,
  ListChecks,
  FolderOpen,
  Tag,
  Unlink
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import type { GraphFilterState, GraphFilterAction } from '@/hooks/use-graph-filters'
import type { GraphSettings } from '@memry/contracts/graph-api'

interface GraphControlPanelProps {
  filterState: GraphFilterState
  dispatch: Dispatch<GraphFilterAction>
  isFiltered: boolean
  focusLabel: string | null
  settings: GraphSettings
  updateSettings: (updates: Partial<GraphSettings>) => void
}

const ENTITY_FILTERS = [
  { key: 'showNotes' as const, label: 'Notes', icon: FileText, colorVar: '--graph-node-note' },
  {
    key: 'showJournals' as const,
    label: 'Journals',
    icon: BookOpen,
    colorVar: '--graph-node-journal'
  },
  { key: 'showTasks' as const, label: 'Tasks', icon: ListChecks, colorVar: '--graph-node-task' },
  {
    key: 'showProjects' as const,
    label: 'Projects',
    icon: FolderOpen,
    colorVar: '--graph-node-project'
  },
  { key: 'showTags' as const, label: 'Tags', icon: Tag, colorVar: '--graph-node-tag' },
  { key: 'showOrphans' as const, label: 'Orphans', icon: Unlink, colorVar: null }
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
  updateSettings
}: GraphControlPanelProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(true)
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

  if (!isOpen) {
    return (
      <div className="absolute right-3 top-3 z-40">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 bg-popover/95 backdrop-blur-sm shadow-card"
          onClick={() => setIsOpen(true)}
        >
          <ChevronRight className="size-4 text-muted-foreground rotate-180" />
        </Button>
      </div>
    )
  }

  return (
    <div className="absolute right-0 top-0 bottom-0 z-40 w-[260px] border-l border-border bg-popover/95 backdrop-blur-sm overflow-y-auto">
      <div className="p-3 space-y-0.5">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-foreground tracking-wide uppercase">
            Graph Controls
          </span>
          <div className="flex items-center gap-1">
            {isFiltered && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => dispatch({ type: 'RESET_FILTERS' })}
                title="Reset filters"
              >
                <RotateCcw className="size-3 text-muted-foreground" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => setIsOpen(false)}
              title="Close panel"
            >
              <X className="size-3.5 text-muted-foreground" />
            </Button>
          </div>
        </div>

        {/* Focus indicator */}
        {filterState.focusNodeId && focusLabel && (
          <div className="rounded-md border border-accent-cyan/30 bg-accent-cyan/5 px-2.5 py-1.5 mb-2 flex items-center gap-2">
            <Focus className="size-3.5 text-accent-cyan shrink-0" />
            <span className="text-xs text-foreground truncate">{focusLabel}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              depth {filterState.focusDepth}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 ml-auto shrink-0"
              onClick={() => dispatch({ type: 'CLEAR_FOCUS' })}
            >
              <X className="size-3 text-muted-foreground" />
            </Button>
          </div>
        )}

        {/* Filters section */}
        <PanelSection title="Filters" defaultOpen>
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <Input
                ref={inputRef}
                placeholder="Search nodes..."
                className="h-8 pl-8 pr-8 text-xs bg-background border-border"
                value={filterState.searchQuery}
                onChange={(e) => dispatch({ type: 'SET_SEARCH_QUERY', query: e.target.value })}
              />
              {filterState.searchQuery && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 p-0"
                  onClick={() => dispatch({ type: 'SET_SEARCH_QUERY', query: '' })}
                >
                  <X className="size-3 text-muted-foreground" />
                </Button>
              )}
            </div>

            {ENTITY_FILTERS.map(({ key, label, icon: Icon, colorVar }) => {
              const isOrphan = key === 'showOrphans'
              const checked = isOrphan ? filterState.showOrphans : (filterState[key] as boolean)
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
          </div>
        </PanelSection>

        {/* Display section */}
        <PanelSection title="Display" defaultOpen>
          <div className="space-y-3">
            <FilterSwitch
              label="Show labels"
              checked={settings.showLabels}
              onCheckedChange={(v) => updateSettings({ showLabels: v })}
            />
            <FilterSwitch
              label="Edge labels"
              checked={settings.showEdgeLabels}
              onCheckedChange={(v) => updateSettings({ showEdgeLabels: v })}
            />
            <FilterSwitch
              label="Tag nodes"
              checked={settings.showTagEdges}
              onCheckedChange={(v) => updateSettings({ showTagEdges: v })}
            />

            <PanelSlider
              label="Text fade threshold"
              value={settings.showLabels ? 6 : 0}
              min={0}
              max={20}
              onChange={(v) => updateSettings({ showLabels: v > 0 })}
            />
            <PanelSlider
              label="Node size"
              value={
                settings.nodeSizing === 'uniform'
                  ? 50
                  : settings.nodeSizing === 'by-connections'
                    ? 75
                    : 100
              }
              min={0}
              max={100}
              onChange={(v) => {
                const sizing = v < 33 ? 'uniform' : v < 66 ? 'by-connections' : 'by-word-count'
                updateSettings({
                  nodeSizing: sizing as GraphSettings['nodeSizing']
                })
              }}
            />

            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs"
              onClick={() => updateSettings({ animateLayout: !settings.animateLayout })}
            >
              {settings.animateLayout ? 'Stop animation' : 'Animate'}
            </Button>
          </div>
        </PanelSection>

        {/* Forces section */}
        <PanelSection title="Forces" defaultOpen={false}>
          <div className="space-y-3">
            <PanelSlider
              label="Center force"
              value={Math.round(100 - settings.linkDistance / 2)}
              min={0}
              max={100}
              onChange={(v) => updateSettings({ linkDistance: Math.round((100 - v) * 2) })}
            />
            <PanelSlider
              label="Repel force"
              value={settings.repulsionStrength}
              min={1}
              max={100}
              onChange={(v) => updateSettings({ repulsionStrength: v })}
            />
            <PanelSlider
              label="Link distance"
              value={settings.linkDistance}
              min={10}
              max={200}
              onChange={(v) => updateSettings({ linkDistance: v })}
            />
          </div>
        </PanelSection>
      </div>
    </div>
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
        <div className="pb-2 pl-1">{children}</div>
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

function PanelSlider({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-foreground font-normal">{label}</Label>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={([v]) => onChange(v)}
        className="py-0.5"
      />
    </div>
  )
}
