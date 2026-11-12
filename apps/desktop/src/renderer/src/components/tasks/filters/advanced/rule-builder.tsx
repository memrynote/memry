import {
  countTaskFilterRules,
  type TaskFilterGroup,
  type TaskFilterMatch,
  type TaskFilterNode
} from '@memry/domain-tasks/filtering'
import { useT } from '@memry/i18n/renderer'
import { ChevronDown, Plus, X } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import {
  GROUP_MATCHES,
  appendNodeAt,
  newRule,
  updateNodeAt,
  type NodePath
} from '@/lib/task-filter-rules'
import { cn } from '@/lib/utils'
import { matchLabel } from './rule-labels'
import { RuleRow } from './rule-row'
import type { RuleValueContext } from './rule-value'

const K = 'filters.advanced'

interface RuleBuilderProps extends RuleValueContext {
  expression: TaskFilterGroup
  onChange: (expression: TaskFilterGroup) => void
  onClear: () => void
  matchCount: number
}

const isGroup = (node: TaskFilterNode): node is TaskFilterGroup => 'match' in node

const countLeaves = (group: TaskFilterGroup): number =>
  group.rules.reduce((n, node) => n + (isGroup(node) ? countLeaves(node) : 1), 0)

function MatchSelect({
  match,
  onChange
}: {
  match: string
  onChange: (match: TaskFilterMatch) => void
}): React.JSX.Element {
  const { t } = useT('tasks')
  return (
    <Picker
      value={match}
      onValueChange={(value) => {
        if (value === 'all' || value === 'any' || value === 'none') onChange(value)
      }}
    >
      <Picker.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-[22px] items-center gap-1 rounded-[5px] bg-muted px-1.5 text-[11.5px] font-semibold text-foreground',
            match === 'none' && 'bg-[var(--tint)]/10 text-[var(--tint)]'
          )}
        >
          {matchLabel(match, t)}
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      </Picker.Trigger>
      <Picker.Content width={120} align="start">
        <Picker.List>
          {GROUP_MATCHES.map((value) => (
            <Picker.Item key={value} value={value} label={matchLabel(value, t)} indicator="check" />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}

/** The rule editor shown in the advanced filter popover. */
export function RuleBuilder({
  expression,
  onChange,
  onClear,
  matchCount,
  ...ctx
}: RuleBuilderProps): React.JSX.Element {
  const { t } = useT('tasks')
  const skipped = countLeaves(expression) - countTaskFilterRules(expression)

  const renderNodes = (group: TaskFilterGroup, path: NodePath): React.ReactNode =>
    group.rules.map((node, index) => {
      const nodePath = [...path, index]
      if (!isGroup(node)) {
        return (
          <RuleRow
            // oxlint-disable-next-line react/no-array-index-key -- the synced tree has no node ids; a row keeps only transient picker state
            key={index}
            rule={node}
            onChange={(rule) => onChange(updateNodeAt(expression, nodePath, () => rule))}
            onRemove={() => onChange(updateNodeAt(expression, nodePath, () => null))}
            {...ctx}
          />
        )
      }
      return (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- the synced tree has no node ids
          key={index}
          data-testid="rule-group"
          className={cn(
            'flex flex-col gap-1.5 border-s-2 py-1 ps-2.5',
            node.match === 'none' ? 'border-[var(--tint)]' : 'border-border'
          )}
        >
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {t(`${K}.match`)}
            <MatchSelect
              match={node.match}
              onChange={(match) =>
                onChange(updateNodeAt(expression, nodePath, (n) => ({ ...n, match })))
              }
            />
            {t(`${K}.ofThese`)}
            <button
              type="button"
              onClick={() => onChange(updateNodeAt(expression, nodePath, () => null))}
              aria-label={t(`${K}.removeGroup`)}
              className="ms-auto flex size-[22px] items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          {renderNodes(node, nodePath)}
          <button
            type="button"
            onClick={() => onChange(appendNodeAt(expression, nodePath, newRule('priority')))}
            className="flex items-center gap-1 self-start text-[11.5px] font-medium text-[var(--tint)]"
          >
            <Plus className="size-3" />
            {t(`${K}.addRule`)}
          </button>
        </div>
      )
    })

  return (
    <div className="flex flex-col" data-testid="rule-builder">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-[11.5px] text-muted-foreground">
        <span className="text-xs font-semibold text-foreground">{t(`${K}.title`)}</span>
        <span className="grow" />
        {t(`${K}.match`)}
        <MatchSelect
          match={expression.match}
          onChange={(match) => onChange({ ...expression, match })}
        />
        {t(`${K}.ofThese`)}
      </div>

      <div className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto p-3">
        {expression.rules.length === 0 ? (
          <p className="py-2 text-[12px] text-muted-foreground">{t(`${K}.empty`)}</p>
        ) : (
          renderNodes(expression, [])
        )}
      </div>

      <div className="flex items-center gap-3.5 border-t border-border px-3 py-2.5 text-xs">
        <button
          type="button"
          onClick={() => onChange(appendNodeAt(expression, [], newRule('priority')))}
          className="flex items-center gap-1 font-semibold text-[var(--tint)]"
        >
          <Plus className="size-3.5" />
          {t(`${K}.addRule`)}
        </button>
        {/* Groups are offered at the top level only; a deeper tree from another device still renders. */}
        <button
          type="button"
          onClick={() =>
            onChange(appendNodeAt(expression, [], { match: 'any', rules: [newRule('priority')] }))
          }
          className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t(`${K}.addGroup`)}
        </button>
        <span className="grow" />
        <span className="text-muted-foreground" data-testid="rule-match-count">
          {t(`${K}.matchCount`, { count: matchCount })}
          {skipped > 0 && ` · ${t(`${K}.skipped`, { count: skipped })}`}
        </span>
        <span className="h-3.5 w-px bg-border" />
        <button
          type="button"
          onClick={onClear}
          className="font-medium text-muted-foreground hover:text-foreground"
        >
          {t(`${K}.clear`)}
        </button>
      </div>
    </div>
  )
}
