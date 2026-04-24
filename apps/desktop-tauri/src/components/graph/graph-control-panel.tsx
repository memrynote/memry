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
  Unlink,
  Settings
} from '@/lib/icons'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
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
  const [isOpen, setIsOpen] = useState(false)
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
        onClick={() => setIsOpen((v) => !v)}
        className="absolute right-3 top-3 z-50 flex size-8 items-center justify-center rounded-md border border-border bg-popover/95 backdrop-blur-sm shadow-card transition-colors hover:bg-accent"
        title={isOpen ? 'Hide settings' : 'Graph settings'}
      >
        <Settings
          className={`size-4 text-muted-foreground transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Sliding drawer */}
      <div
        className={`absolute right-0 top-0 z-40 w-[260px] max-h-full border-l border-border bg-popover/95 backdrop-blur-sm rounded-bl-lg overflow-y-auto transition-transform duration-250 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="p-3 space-y-0.5">
          {isFiltered && (
            <div className="flex justify-end mb-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => dispatch({ type: 'RESET_FILTERS' })}
                title="Reset filters"
              >
                <RotateCcw className="size-3 text-muted-foreground" />
              </Button>
            </div>
          )}

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
            </div>
          </PanelSection>
        </div>
      </div>
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
