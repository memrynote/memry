import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import { Tag, X } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { PropertyRow } from '@/components/note/info-section/PropertyRow'
import type { Property, PropertyType } from '@/components/note/info-section/types'
import type { Task } from '@/data/task-model'

type TaskFields = NonNullable<Task['fields']>
import { buildFieldGroups, isFilledValue, type FieldSlot } from '../build-field-groups'
import { useTagSchemas } from '../use-tag-schemas'
import { isRelationField } from './task-relation-chip-model'

interface TaskFieldGroupsProps {
  tags: readonly string[]
  fields: TaskFields
  /** A patch: name -> value, `null` removes the value. */
  onFieldsChange: (patch: TaskFields) => void
}

/**
 * The task drawer's field groups, under the Tags row. A task has no inline
 * tags, so every tag with fields brings its group. An empty slot writes
 * nothing; a value goes in only when the user sets one.
 */
export function TaskFieldGroups({ tags, fields, onFieldsChange }: TaskFieldGroupsProps) {
  const { t } = useT('notes')
  const { data: snapshot } = useTagSchemas()
  const { groups, rest } = useMemo(
    () => buildFieldGroups(tags, snapshot, fields),
    [tags, snapshot, fields]
  )
  const filledRest = rest.filter((entry) => isFilledValue(entry.value))
  if (groups.length === 0 && filledRest.length === 0) return null

  const write = (name: string, previous: unknown, next: unknown) => {
    if (isFilledValue(next)) {
      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        onFieldsChange({ [name]: next as TaskFields[string] })
      }
    } else if (isFilledValue(previous)) {
      onFieldsChange({ [name]: null })
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      {groups.map((group) => (
        <FieldGroupCard
          key={`${group.tag.key}:${group.via?.key ?? ''}`}
          tag={group.tag}
          title={
            group.via
              ? t('tagFields.tasks.viaTag', { name: group.tag.name, via: group.via.name })
              : group.tag.name
          }
        >
          {group.slots.map((slot) => (
            <PropertyRow
              key={slot.field.name}
              property={slotProperty(slot)}
              onValueChange={(next) => write(slot.field.name, slot.value, next)}
            />
          ))}
        </FieldGroupCard>
      ))}
      {filledRest.length > 0 && (
        <FieldGroupCard tag={null} title={t('tagFields.tasks.thisTask')}>
          {filledRest.map(({ name, value }) => (
            <PropertyRow
              key={name}
              property={{ id: name, name, type: inferType(value), value, isCustom: false }}
              onValueChange={(next) => write(name, value, next)}
              renderAction={(hovered) => (
                <button
                  type="button"
                  aria-label={t('tagFields.tasks.clearValue', { name })}
                  onClick={() => onFieldsChange({ [name]: null })}
                  className={
                    'ms-1 flex h-6 w-6 items-center justify-center rounded text-text-tertiary ' +
                    'transition-opacity hover:bg-surface hover:text-foreground focus-visible:opacity-100 ' +
                    (hovered ? 'opacity-100' : 'opacity-0')
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            />
          ))}
        </FieldGroupCard>
      )}
    </div>
  )
}

function FieldGroupCard({
  tag,
  title,
  children
}: {
  tag: ResolvedTag | null
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-background px-2.5 py-2">
      <header className="flex items-center gap-1.5 pb-1 text-[12px] font-semibold text-foreground">
        {tag &&
          (tag.icon ? (
            <NoteIconDisplay value={tag.icon} className="size-3.5 text-[13px] leading-none" />
          ) : (
            <Tag aria-hidden className="h-3.5 w-3.5" style={{ color: tag.color }} />
          ))}
        <span className="truncate">{title}</span>
      </header>
      {children}
    </section>
  )
}

function slotProperty(slot: FieldSlot): Property {
  return {
    id: slot.field.name,
    name: slot.field.name,
    type: isRelationField(slot.field) ? 'relation' : slot.field.type,
    value: slot.value ?? null,
    isCustom: false
  }
}

/** A value no tag lists any more has no definition to read; draw it by its shape. */
function inferType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.startsWith('memry://')))
    return 'relation'
  return 'text'
}
