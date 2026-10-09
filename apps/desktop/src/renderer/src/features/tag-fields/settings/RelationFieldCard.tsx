import { useId, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { RelationConfig } from '@memry/contracts/tag-schema'
import { ArrowUpRight } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { TagChip } from './TagChip'
import { capitalize } from './settings-logic'

interface RelationFieldCardProps {
  /** Field name, shown in the header. */
  name: string
  /** Display name of the tag that owns the field: the inverse placeholder. */
  tagName: string
  initial: RelationConfig | null
  submitLabel: string
  onSubmit: (relation: RelationConfig) => Promise<void>
  onCancel: () => void
}

/** B2 panel 2: a relation's target tag, one or many, and its inverse label. */
export function RelationFieldCard({
  name,
  tagName,
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: RelationFieldCardProps): React.JSX.Element {
  const { t } = useT('notes')
  const { tags } = useNoteTagsQuery()
  const [target, setTarget] = useState<string | null>(initial?.target ?? null)
  const [many, setMany] = useState(initial?.many ?? false)
  const [inverse, setInverse] = useState(initial?.inverse ?? '')
  const [busy, setBusy] = useState(false)
  const inverseId = useId()

  const targetRow = target ? tags.find((row) => row.tag.toLowerCase() === target) : undefined

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit({ target, many, inverse: inverse.trim() || null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ArrowUpRight className="size-4 text-text-secondary" />
        <span className="text-sm font-semibold">{name}</span>
        <span className="text-xs text-text-tertiary">{t('tagFields.settings.types.relation')}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-secondary">
          {t('tagFields.settings.relation.target')}
        </span>
        <Select value={target ?? undefined} onValueChange={(value) => setTarget(value)}>
          <SelectTrigger className="h-8" aria-label={t('tagFields.settings.relation.target')}>
            {target ? (
              <TagChip
                name={targetRow?.tag ?? target}
                color={targetRow?.color ?? ''}
                icon={targetRow?.icon ?? null}
              />
            ) : (
              <span className="text-text-tertiary">{t('tagFields.settings.relation.pickTag')}</span>
            )}
          </SelectTrigger>
          <SelectContent>
            {tags.map((row) => (
              <SelectItem key={row.tag} value={row.tag.toLowerCase()}>
                <TagChip name={row.tag} color={row.color} icon={row.icon} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-secondary">
          {t('tagFields.settings.relation.howMany')}
        </span>
        <ToggleGroup
          type="single"
          value={many ? 'many' : 'one'}
          onValueChange={(value) => value && setMany(value === 'many')}
          className="grid grid-cols-2 rounded-md bg-muted p-0.5"
        >
          <ToggleGroupItem value="one" className="h-7 data-[state=on]:bg-background">
            {t('tagFields.settings.relation.one')}
          </ToggleGroupItem>
          <ToggleGroupItem value="many" className="h-7 data-[state=on]:bg-background">
            {t('tagFields.settings.relation.many')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={inverseId} className="text-xs text-text-secondary">
          {target
            ? t('tagFields.settings.relation.inverseLabel', { target })
            : t('tagFields.settings.relation.inverseLabelAny')}
        </label>
        <Input
          id={inverseId}
          value={inverse}
          onChange={(event) => setInverse(event.target.value)}
          placeholder={capitalize(tagName)}
          className="h-8"
        />
        <span className="text-xs text-text-tertiary">
          {target
            ? t('tagFields.settings.relation.inverseHint', { target })
            : t('tagFields.settings.relation.inverseHintAny')}
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('tagFields.settings.cancel')}
        </Button>
        <Button size="sm" disabled={busy || !target} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
