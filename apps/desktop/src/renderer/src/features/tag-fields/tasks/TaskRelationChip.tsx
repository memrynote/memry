import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import { Tag } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { propertiesService } from '@/services/properties-service'
import type { Task } from '@/data/task-model'

type TaskFields = NonNullable<Task['fields']>
import { buildFieldGroups } from '../build-field-groups'
import { useObjectIdentity, useTagSchemas } from '../use-tag-schemas'
import { firstRelationChip } from './task-relation-chip-model'

function initialsOf(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map((word) => word[0].toLocaleUpperCase())
    .join('')
}

/**
 * "Waiting on Ahmet Yılmaz": the first filled relation field of a task row.
 * Renders nothing when the task has none, so plain rows stay unchanged.
 */
export function TaskRelationChip({
  tags,
  fields
}: {
  tags: readonly string[]
  fields: TaskFields
}) {
  const { t } = useT('notes')
  const { data: snapshot } = useTagSchemas()
  const chip = useMemo(
    () => firstRelationChip(buildFieldGroups(tags, snapshot, fields).groups),
    [tags, snapshot, fields]
  )
  const identity = useObjectIdentity(chip?.noteId)
  const { data: ref } = useQuery({
    queryKey: ['properties', 'resolve-ref', chip?.uri],
    queryFn: async () => (await propertiesService.resolveRefs([chip!.uri]))[0] ?? null,
    enabled: !!chip,
    staleTime: 60_000
  })
  if (!chip || !ref || !ref.exists) return null

  // Full title, not the first name the board shows: two Ahmets stay apart.
  const title = ref.title
  return (
    <span
      className="flex min-w-0 max-w-[200px] shrink items-center gap-1 rounded-full bg-tint/10 py-0.5 ps-0.5 pe-2 text-[11px] leading-3.5 text-foreground/80"
      aria-label={t('tagFields.tasks.chipAria', { field: chip.field, title })}
    >
      {identity?.avatar ? (
        <span
          aria-hidden
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-semibold text-white"
          style={{ backgroundColor: identity.color }}
        >
          {initialsOf(title)}
        </span>
      ) : identity ? (
        <span
          aria-hidden
          className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface"
        >
          {identity.icon ? (
            <NoteIconDisplay value={identity.icon} className="size-3 text-[10px] leading-none" />
          ) : (
            <Tag className="size-3" style={{ color: identity.color }} />
          )}
        </span>
      ) : null}
      <span className="truncate">
        {chip.field} {title}
      </span>
    </span>
  )
}
