import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedField } from '@memry/contracts/tag-schema'
import type { LinkedHereGroup } from '@memry/contracts/tag-objects-api'
import { parseRelationValue } from '@memry/contracts/relation-uri'
import { propertiesService } from '@/services/properties-service'
import { tagsService } from '@/services/tags-service'
import { onNoteUpdated } from '@/services/notes-service'
import { getActiveLocale } from '@/lib/active-locale'
import { ArrowUpRight, CheckSquare, Mail, Phone, Users, type AppIcon } from '@/lib/icons'
import { ObjectAvatar, type ObjectLook } from './object-avatar'
import { RelationTitles } from './relation-titles'
import { useTagSchemas } from './use-tag-schemas'

const objectPreviewKey = (noteId: string) => ['tags', 'object-preview', noteId] as const

interface ObjectPreviewData {
  values: Record<string, unknown>
  linked: LinkedHereGroup[]
}

const isFilled = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0)

function relationUris(value: unknown): string[] {
  return parseRelationValue(value)
    .filter((ref) => ref.kind === 'note')
    .map((ref) => `memry://note/${ref.id}`)
}

function lineIcon(field: ResolvedField, value: unknown): AppIcon {
  if (typeof value === 'string' && /^\S+@\S+\.\S+$/u.test(value)) return Mail
  if (typeof value === 'string' && /^\+?[\d\s()-]{6,}$/u.test(value)) return Phone
  return field.type === 'relation' ? Users : CheckSquare
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(getActiveLocale(), { month: 'short', day: 'numeric' }).format(date)
}

export function ObjectPreviewBody({
  noteId,
  title,
  look,
  onOpen
}: {
  noteId: string
  title: string
  look: ObjectLook
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const queryClient = useQueryClient()
  const { data: snapshot } = useTagSchemas()
  const { data } = useQuery({
    queryKey: objectPreviewKey(noteId),
    queryFn: async (): Promise<ObjectPreviewData> => {
      const [properties, linked] = await Promise.all([
        propertiesService.get(noteId),
        tagsService.getLinkedHere({ noteId, limitPerGroup: 1 })
      ])
      const values: Record<string, unknown> = {}
      for (const property of properties) values[property.name] = property.value
      return { values, linked: linked.groups }
    },
    staleTime: 30_000
  })

  useEffect(
    () =>
      onNoteUpdated((event) => {
        if (event.id === noteId)
          void queryClient.invalidateQueries({ queryKey: objectPreviewKey(noteId) })
      }),
    [noteId, queryClient]
  )

  const fields = snapshot?.tags[look.tag]?.effectiveFields ?? []
  const values = data?.values ?? {}
  const filled = fields.filter((field) => isFilled(values[field.name]))
  const firstText = filled.find((field) => field.type !== 'relation')
  const firstRelation = filled.find((field) => field.type === 'relation')
  const lines = filled
    .filter((field) => field !== firstText && field !== firstRelation && field.type !== 'checkbox')
    .slice(0, 2)

  const linked = data?.linked ?? []
  const meeting = linked.find(
    (group): group is Extract<LinkedHereGroup, { kind: 'relation' }> =>
      group.kind === 'relation' && snapshot?.tags[group.sourceTag]?.preset === 'meeting'
  )
  const tasks = linked.filter(
    (group): group is Extract<LinkedHereGroup, { kind: 'task-field' }> =>
      group.kind === 'task-field'
  )
  const mentions = linked.find((group) => group.kind === 'mentions')?.total ?? 0

  return (
    <div className="flex flex-col text-[13px]" data-testid="object-preview">
      <div className="flex flex-col gap-2.5 p-3.5">
        <div className="flex items-center gap-3">
          <ObjectAvatar look={look} title={title} size={40} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold text-text-bright">{title}</span>
            {(firstText || firstRelation) && (
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                {firstText && <span className="truncate">{String(values[firstText.name])}</span>}
                {firstText && firstRelation && <span>{t('tagObjects.hover.at')}</span>}
                {firstRelation && (
                  <RelationTitles uris={relationUris(values[firstRelation.name]).slice(0, 1)} />
                )}
              </span>
            )}
          </div>
        </div>
        {lines.map((field) => {
          const value = values[field.name]
          const Icon = lineIcon(field, value)
          return (
            <div key={field.name} className="flex min-w-0 items-center gap-2">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              {field.type === 'relation' ? (
                <RelationTitles uris={relationUris(value)} />
              ) : (
                <span className="truncate">
                  {Array.isArray(value) ? value.join(', ') : String(value)}
                </span>
              )}
            </div>
          )
        })}
        {meeting?.items[0] && (
          <div className="flex min-w-0 items-center gap-2">
            <Users className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {shortDate(meeting.items[0].date)
                ? t('tagObjects.hover.lastMetOn', {
                    date: shortDate(meeting.items[0].date),
                    title: meeting.items[0].title
                  })
                : t('tagObjects.hover.lastMet', { title: meeting.items[0].title })}
            </span>
          </div>
        )}
        {tasks.map((group) => (
          <div key={`${group.tag}-${group.field}`} className="flex min-w-0 items-center gap-2">
            <CheckSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {t('tagObjects.hover.tasks', { count: group.total, field: group.field })}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-b-[10px] border-t border-border/60 bg-[var(--surface-active)] px-3.5 py-2 text-xs text-muted-foreground">
        <span>{t('tagObjects.hover.mentionedIn', { count: mentions })}</span>
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 font-medium text-foreground hover:opacity-80"
        >
          {t('tagObjects.hover.open')}
          <ArrowUpRight className="size-3" />
        </button>
      </div>
    </div>
  )
}
