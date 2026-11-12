import { useMemo } from 'react'
import { countTaskFilterRules, type TaskFilterGroup } from '@memry/domain-tasks/filtering'
import { useT } from '@memry/i18n/renderer'
import { X } from '@/lib/icons'
import type { Project } from '@/data/tasks-data'
import type { TaskNoteIndex } from '@/lib/task-note-index'
import { cn } from '@/lib/utils'
import { summarizeExpression } from './rule-labels'

const K = 'filters.advanced'

interface RuleSummaryPillProps {
  expression: TaskFilterGroup
  projects: Project[]
  noteIndex?: TaskNoteIndex
  onEdit?: () => void
  onClear: () => void
}

/** The rules read back as one sentence above the list. */
export function RuleSummaryPill({
  expression,
  projects,
  noteIndex,
  onEdit,
  onClear
}: RuleSummaryPillProps): React.JSX.Element | null {
  const { t } = useT('tasks')
  const tokens = useMemo(
    () => summarizeExpression(expression, { projects, noteIndex, t }),
    [expression, projects, noteIndex, t]
  )
  const count = countTaskFilterRules(expression)
  if (count === 0) return null

  return (
    <div
      data-testid="rule-summary"
      className="flex min-w-0 shrink items-center gap-[5px] rounded-[5px] border border-[#5E6AD233] bg-[#5E6AD21A] py-[3px] pe-1 ps-2"
    >
      <button
        type="button"
        onClick={onEdit}
        title={t(`${K}.editRules`)}
        className="flex min-w-0 items-center gap-1 text-[11px] leading-3.5"
      >
        <span className="truncate">
          {tokens.map((token, i) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- tokens are re-derived each render and hold no state; repeated words make text keys collide
              key={i}
              className={cn(
                token.kind === 'field' && 'text-text-secondary',
                token.kind === 'value' && 'font-medium text-foreground',
                token.kind === 'logic' && 'font-semibold text-[var(--tint)]',
                token.kind === 'paren' && 'text-text-tertiary'
              )}
            >
              {i > 0 ? ' ' : ''}
              {token.text}
            </span>
          ))}
        </span>
        <span className="shrink-0 border-s border-border ps-1.5 text-text-tertiary">
          {t(`${K}.ruleCount`, { count })}
        </span>
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label={t(`${K}.clearRules`)}
        className="flex size-4 shrink-0 items-center justify-center rounded-[3px] transition-opacity hover:opacity-70"
      >
        <X size={10} className="text-text-tertiary" />
      </button>
    </div>
  )
}
