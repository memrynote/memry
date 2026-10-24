import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { buildTaskTree } from '@memry/domain-tasks/tree'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { useSubtaskTree } from './subtask-tree-context'

interface MoveUnderDialogProps {
  task: Task | null
  tasks: Task[]
  projects: Project[]
  onClose: () => void
}

interface Place {
  id: string | null
  title: string
  depth: number
  /** Ancestor titles, outermost first; shown while searching. */
  path: string[]
  disabled: boolean
  note: 'current' | 'self' | null
}

const TOP_LEVEL = '__top-level__'

/**
 * "Move under…": the task's project as the same tree the list draws, so the
 * user picks a place, not a name. The task's own branch cannot be picked, and
 * typing searches every level and shows each match with its path.
 */
export const MoveUnderDialog = ({
  task,
  tasks,
  projects,
  onClose
}: MoveUnderDialogProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tree = useSubtaskTree()
  const [query, setQuery] = useState('')

  const { places, branchSize } = useMemo((): { places: Place[]; branchSize: number } => {
    if (!task || !tree) return { places: [], branchSize: 0 }
    const projectTasks = tasks.filter((x) => x.projectId === task.projectId && !x.archivedAt)
    const taskTree = buildTaskTree(projectTasks)
    const branch = new Set([task.id, ...taskTree.descendantIds(task.id)])
    const out: Place[] = []
    const walk = (nodes: Task[], depth: number, path: string[]): void => {
      for (const node of nodes) {
        const inBranch = branch.has(node.id)
        out.push({
          id: node.id,
          title: node.title,
          depth,
          path,
          disabled: inBranch || !tree.canMoveUnder(task.id, node.id),
          note: node.id === task.id ? 'self' : node.id === task.parentId ? 'current' : null
        })
        walk(taskTree.childrenOf(node.id), depth + 1, [...path, node.title])
      }
    }
    walk(taskTree.roots, 0, [])
    return { places: out, branchSize: branch.size - 1 }
  }, [task, tasks, tree])

  const needle = query.trim().toLowerCase()
  const visible = needle ? places.filter((p) => p.title.toLowerCase().includes(needle)) : places
  const project = projects.find((p) => p.id === task?.projectId)

  const choose = (parentId: string | null): void => {
    if (!task || !tree) return
    tree.moveUnder(task.id, parentId)
    setQuery('')
    onClose()
  }

  return (
    <Dialog
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) {
          setQuery('')
          onClose()
        }
      }}
    >
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl [&>button]:hidden">
        <DialogTitle className="sr-only">{t('subtaskTree.moveUnder.title')}</DialogTitle>
        <Command
          shouldFilter={false}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              choose(null)
            }
          }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            {task && (
              <span className="max-w-[40%] shrink-0 truncate rounded-sm bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                {task.title}
              </span>
            )}
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t('subtaskTree.moveUnder.placeholder')}
              className="border-0"
            />
          </div>
          <CommandList className="max-h-[360px] p-1.5">
            <CommandEmpty>{t('subtaskTree.moveUnder.empty')}</CommandEmpty>
            {!needle && task?.parentId && (
              <CommandItem value={TOP_LEVEL} onSelect={() => choose(null)} className="gap-2.5">
                <span
                  className="size-2 shrink-0 rounded-xs"
                  style={{ backgroundColor: project?.color }}
                  aria-hidden="true"
                />
                <span className="grow truncate font-medium">
                  {t('subtaskTree.moveUnder.topLevel', { project: project?.name ?? '' })}
                </span>
                <span className="text-xs text-text-tertiary">⌘↵</span>
              </CommandItem>
            )}
            {visible.map((place) => (
              <CommandItem
                key={place.id}
                value={place.id ?? TOP_LEVEL}
                disabled={place.disabled}
                onSelect={() => choose(place.id)}
                className="gap-2.5"
                data-testid="move-under-place"
              >
                {!needle &&
                  Array.from({ length: place.depth }, (_, i) => (
                    <span
                      key={i}
                      className="-my-2 w-3 shrink-0 self-stretch border-s border-border"
                    />
                  ))}
                <span
                  className={cn(
                    'size-3 shrink-0 rounded-full border-[1.5px]',
                    place.disabled ? 'border-border' : 'border-text-tertiary'
                  )}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 grow flex-col">
                  <span className={cn('truncate', place.disabled && 'text-text-tertiary')}>
                    {place.title}
                  </span>
                  {needle && place.path.length > 0 && (
                    <span className="truncate text-xs text-text-tertiary">
                      {place.path.join(' › ')}
                    </span>
                  )}
                </span>
                {place.note && (
                  <span className="shrink-0 text-xs text-text-tertiary">
                    {place.note === 'self'
                      ? t('subtaskTree.moveUnder.thisTask')
                      : t('subtaskTree.moveUnder.currentParent')}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
          <div className="flex items-center justify-between border-t border-border bg-muted/40 px-3 py-2 text-xs text-text-tertiary">
            <span className="truncate">
              {task &&
                (branchSize > 0
                  ? t('subtaskTree.moveUnder.movesBranch', { title: task.title, count: branchSize })
                  : t('subtaskTree.moveUnder.movesOne', { title: task.title }))}
            </span>
            <span className="shrink-0">{t('subtaskTree.moveUnder.keys')}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
