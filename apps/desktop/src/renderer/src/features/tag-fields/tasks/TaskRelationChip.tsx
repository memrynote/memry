import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import { propertiesService } from '@/services/properties-service'
import type { Task } from '@/data/task-model'
import { withAlpha } from '@/components/note/tags-row/tag-colors'
import { cn } from '@/lib/utils'

type TaskFields = NonNullable<Task['fields']>
import { buildFieldGroups } from '../build-field-groups'
import { ObjectAvatar, objectColor } from '../object-avatar'
import { useObjectIdentity, useTagSchemas } from '../use-tag-schemas'
import { firstRelationChip } from './task-relation-chip-model'

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

  const title = ref.title
  return (
    <span
      className={cn(
        'flex min-w-0 max-w-[200px] shrink items-center gap-1 rounded-full py-0.5 ps-0.5 pe-2 text-[11px] leading-3.5 text-foreground/80',
        !identity && 'bg-tint/10'
      )}
      style={identity ? { backgroundColor: withAlpha(objectColor(identity), 0.1) } : undefined}
      aria-label={t('tagFields.tasks.chipAria', { field: chip.field, title })}
    >
      {identity && <ObjectAvatar look={identity} title={title} size={16} />}
      <span className="truncate">
        {chip.field} {title}
      </span>
    </span>
  )
}
