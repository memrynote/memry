import { useQuery } from '@tanstack/react-query'
import { propertiesService, type ResolvedRelationRef } from '@/services/properties-service'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { cn } from '@/lib/utils'
import { ObjectAvatar, type ObjectLook } from './object-avatar'
import { useObjectIdentityLookup } from './use-tag-schemas'

/** Relation URIs resolved to titles; cached per value, refreshed on mount. */
export function useResolvedRefs(uris: readonly string[]): ResolvedRelationRef[] {
  const { data } = useQuery({
    queryKey: ['tags', 'resolved-refs', ...uris],
    queryFn: () => propertiesService.resolveRefs([...uris]),
    enabled: uris.length > 0,
    staleTime: 10_000
  })
  return uris.length === 0 ? [] : (data ?? [])
}

/**
 * The object chip of the boards: a pill in 10% of the tag colour, an 18px
 * avatar or icon tile, the title in ink. An explicit note emoji wins.
 */
export function ObjectChip({
  look,
  title,
  emoji,
  className
}: {
  look: ObjectLook | null
  title: string
  emoji?: string | null
  className?: string
}): React.JSX.Element {
  const color = look ? getTagColors(look.color, look.tag).text : null
  return (
    <span
      data-object-chip
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full py-0.5 ps-0.5 pe-2 text-[13px] font-medium text-foreground',
        !color && 'bg-muted ps-2',
        className
      )}
      style={color ? { backgroundColor: withAlpha(color, 0.1) } : undefined}
    >
      {emoji ? (
        <span className="text-[13px] leading-none">
          <NoteIconDisplay value={emoji} />
        </span>
      ) : (
        look && <ObjectAvatar look={look} title={title} size={18} />
      )}
      <span className="truncate">{title}</span>
    </span>
  )
}

/** Chips for a relation value (quick-fields card, table cells, hover card). */
export function RelationTitles({
  uris,
  className
}: {
  uris: readonly string[]
  className?: string
}): React.JSX.Element {
  const refs = useResolvedRefs(uris)
  const identityOf = useObjectIdentityLookup()
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {refs
        .filter((ref) => ref.exists)
        .map((ref) => (
          <ObjectChip
            key={ref.uri}
            look={ref.targetType === 'note' ? identityOf(ref.targetId) : null}
            title={ref.title}
            emoji={ref.emoji}
          />
        ))}
    </span>
  )
}
