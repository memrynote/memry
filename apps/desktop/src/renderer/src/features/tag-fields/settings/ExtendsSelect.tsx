import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { CornerDownRight } from '@/lib/icons'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useEditTagSchema } from '../use-tag-schemas'
import { TagChip } from './TagChip'
import { isExtendsCandidateDisabled } from './settings-logic'
import { tagDisplayName } from '../tag-display-name'

const NOTHING = '__nothing__'

interface ExtendsSelectProps {
  tagKey: string
  tag: ResolvedTag | null
  snapshot: TagSchemaSnapshot | undefined
  disabled: boolean
}

/** B1/H1 EXTENDS: one parent or Nothing; parents that would form a loop are greyed out. */
export function ExtendsSelect({
  tagKey,
  tag,
  snapshot,
  disabled
}: ExtendsSelectProps): React.JSX.Element {
  const { t } = useT('notes')
  const editSchema = useEditTagSchema()
  const parentKey = tag?.extends ?? null
  const parent = parentKey ? (snapshot?.tags[parentKey] ?? null) : null
  const candidates = Object.values(snapshot?.tags ?? {})
    .filter((candidate) => candidate.key !== tagKey)
    .sort((a, b) => a.name.localeCompare(b.name))

  const change = async (value: string): Promise<void> => {
    const next = value === NOTHING ? null : value
    if (next === parentKey) return
    try {
      await editSchema({ kind: 'set-extends', tag: tagKey, parent: next })
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.extends')))
    }
  }

  return (
    <div className="flex items-start gap-3">
      <Select
        value={parentKey ?? NOTHING}
        disabled={disabled}
        onValueChange={(value) => void change(value)}
      >
        <SelectTrigger
          className="h-8 w-[170px] shrink-0"
          aria-label={t('tagFields.settings.sections.extends')}
        >
          {parentKey ? (
            // A div, not the chip's own span: the trigger line-clamps a direct
            // span child, which stacks the chip's icon over its name.
            <div className="flex min-w-0">
              <TagChip
                name={parent?.name ?? parentKey}
                color={parent?.color ?? ''}
                icon={parent?.icon ?? null}
              />
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <CornerDownRight className="size-3.5 text-text-tertiary" />
              {t('tagFields.settings.extends.nothing')}
            </div>
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOTHING}>{t('tagFields.settings.extends.nothing')}</SelectItem>
          {candidates.map((candidate) => (
            <SelectItem
              key={candidate.key}
              value={candidate.key}
              disabled={isExtendsCandidateDisabled(snapshot, tagKey, candidate.key)}
            >
              <TagChip name={candidate.name} color={candidate.color} icon={candidate.icon} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="pt-0.5 text-xs text-text-tertiary">
        {parentKey
          ? t('tagFields.settings.extends.hintSet', {
              tag: tagDisplayName(tag?.name ?? tagKey),
              parent: tagDisplayName(parent?.name ?? parentKey)
            })
          : t('tagFields.settings.extends.hint')}
      </p>
    </div>
  )
}
