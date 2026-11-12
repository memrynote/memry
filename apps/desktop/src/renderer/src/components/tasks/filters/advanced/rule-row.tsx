import type { TaskFilterField, TaskFilterRule } from '@memry/domain-tasks/filtering'
import { useT } from '@memry/i18n/renderer'
import { ChevronDown, X } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import {
  RULE_FIELDS,
  RULE_OPS,
  isNegativeOp,
  isValuelessOp,
  newRule
} from '@/lib/task-filter-rules'
import { cn } from '@/lib/utils'
import { fieldLabel, opLabel } from './rule-labels'
import { RuleValue, type RuleValueContext } from './rule-value'

const K = 'filters.advanced'

interface RuleRowProps extends RuleValueContext {
  rule: TaskFilterRule
  onChange: (rule: TaskFilterRule) => void
  onRemove: () => void
}

const isKnownField = (field: string): field is TaskFilterField => field in RULE_OPS

/** Keeps the values a rule already has when only its operator changes. */
const withOp = (rule: TaskFilterRule, op: string): TaskFilterRule =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `op` comes from RULE_OPS[rule.field], the ops this rule's field accepts
  ({ ...rule, op }) as TaskFilterRule

const selectClass =
  'flex h-[26px] shrink-0 items-center gap-1 rounded-[5px] bg-muted px-2 text-[12px] text-start'

/** One rule: field, operator, value, remove. */
export function RuleRow({ rule, onChange, onRemove, ...ctx }: RuleRowProps): React.JSX.Element {
  const { t } = useT('tasks')
  const removeButton = (
    <button
      type="button"
      onClick={onRemove}
      aria-label={t(`${K}.removeRule`)}
      className="flex size-[22px] shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <X className="size-3" />
    </button>
  )

  // A newer build's rule: shown, kept as is, removable.
  if (!isKnownField(rule.field)) {
    return (
      <div className="flex items-center gap-1.5" data-testid="unknown-rule">
        <div className="flex h-[26px] flex-1 items-center rounded-[5px] bg-muted/50 px-2 text-[12px] text-muted-foreground">
          {t(`${K}.unknownRule`)}
        </div>
        {removeButton}
      </div>
    )
  }

  const ops: readonly string[] = RULE_OPS[rule.field]
  const negative = isNegativeOp(rule.op)

  return (
    <div className="flex items-center gap-1.5" data-testid="rule-row">
      <Picker
        value={rule.field}
        onValueChange={(field) => {
          if (field !== rule.field && isKnownField(field)) onChange(newRule(field))
        }}
      >
        <Picker.Trigger asChild>
          <button type="button" className={cn(selectClass, 'w-[112px] font-medium')}>
            <span className="truncate">{fieldLabel(rule.field, t)}</span>
            <ChevronDown className="ms-auto size-3 shrink-0 opacity-50" />
          </button>
        </Picker.Trigger>
        <Picker.Content width={180} align="start">
          <Picker.List>
            {RULE_FIELDS.map((field) => (
              <Picker.Item
                key={field}
                value={field}
                label={fieldLabel(field, t)}
                indicator="check"
              />
            ))}
          </Picker.List>
        </Picker.Content>
      </Picker>

      <Picker
        value={rule.op}
        onValueChange={(op) => {
          if (op === rule.op) return
          const next = withOp(rule, op)
          onChange(isValuelessOp(op) && 'values' in next ? { ...next, values: [] } : next)
        }}
      >
        <Picker.Trigger asChild>
          <button
            type="button"
            className={cn(
              selectClass,
              'w-[118px]',
              negative && 'bg-[var(--tint)]/10 font-semibold text-[var(--tint)]'
            )}
          >
            <span className="truncate">{opLabel(rule.field, rule.op, t)}</span>
            <ChevronDown className="ms-auto size-3 shrink-0 opacity-50" />
          </button>
        </Picker.Trigger>
        <Picker.Content width={170} align="start">
          <Picker.List>
            {ops.map((op) => (
              <Picker.Item
                key={op}
                value={op}
                label={opLabel(rule.field, op, t)}
                indicator="check"
              />
            ))}
          </Picker.List>
        </Picker.Content>
      </Picker>

      <RuleValue rule={rule} onChange={onChange} {...ctx} />
      {removeButton}
    </div>
  )
}
