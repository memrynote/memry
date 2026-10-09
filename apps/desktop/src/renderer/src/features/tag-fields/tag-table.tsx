import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { FilterExpression } from '@memry/contracts/folder-view-api'
import type { TaskFieldValue } from '@memry/contracts/tasks-api'
import { isRelationValue, parseRelationUri } from '@memry/contracts/relation-uri'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { ChevronDown, ChevronRight, FileText, Plus, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { stringifyUnknown } from '@/lib/stringify-unknown'
import { createObject } from './create-object'
import { ObjectRelationPicker } from './object-relation-picker'
import { RelationTitles, useResolvedRefs } from './relation-titles'

/**
 * F1: what the folder view's table needs to know when it shows a tag with
 * fields. Provided by the tag page; absent everywhere else, so folder tables
 * and plain tags' pages stay exactly as they were.
 */
export interface TagTableValue {
  tag: ResolvedTag
  /** A relation column's target tag (the picker offers only its objects). */
  relationTargetOf(columnId: string): string | null
  /** Task rows edit only the tag's fields, through tasks:update. */
  isFieldColumn(columnId: string): boolean
  /**
   * "+ New {tag} in {group}": creates the object with the group's value
   * prefilled; with ⌘ held it also opens in a new tab.
   */
  createInGroup(property: string, value: unknown, open: boolean): void
}

const TagTableContext = createContext<TagTableValue | null>(null)

export const useTagTable = (): TagTableValue | null => useContext(TagTableContext)

export function TagTableProvider({
  tag,
  onCreated,
  children
}: {
  tag: ResolvedTag | null
  onCreated: (noteId: string, title: string, openInNewTab: boolean) => void
  children: ReactNode
}): React.JSX.Element {
  const { t } = useT('notes')
  const value = useMemo<TagTableValue | null>(() => {
    if (!tag?.hasFields) return null
    const byName = new Map(tag.effectiveFields.map((field) => [field.name, field]))
    return {
      tag,
      relationTargetOf: (columnId) => byName.get(columnId)?.relation?.target ?? null,
      isFieldColumn: (columnId) => byName.has(columnId),
      createInGroup: (property, groupValue, open) => {
        const title = t('tagObjects.table.untitled', { tag: tag.name })
        const properties =
          groupValue === null || groupValue === undefined || groupValue === ''
            ? undefined
            : { [property]: groupValue }
        createObject({ title, tag: tag.key, properties })
          .then((created) => onCreated(created.id, created.title, open))
          .catch((error: unknown) =>
            toast.error(extractErrorMessage(error, t('tagObjects.create.failed')))
          )
      }
    }
  }, [tag, onCreated, t])
  return <TagTableContext.Provider value={value}>{children}</TagTableContext.Provider>
}

/** Writes one task field (task rows of a tag table). `undefined` clears it. */
export async function updateTaskField(
  taskId: string,
  name: string,
  value: TaskFieldValue | undefined
): Promise<void> {
  const result = await tasksService.update({ id: taskId, fields: { [name]: value ?? null } })
  if (!result.success) throw new Error(result.error)
}

/** A relation cell of a tag table: chips, and the target tag's picker on click (E2/F1). */
export function RelationPickerCell({
  value,
  target,
  many,
  onSave
}: {
  value: unknown
  target: string
  many: boolean
  onSave: (next: string[] | undefined) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const uris = isRelationValue(value) ? value : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="relation-picker-cell"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            'flex min-h-6 w-full items-center rounded-md px-1 text-start',
            open && 'ring-1 ring-foreground/60'
          )}
        >
          {uris.length > 0 ? (
            <RelationTitles uris={uris} />
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-auto p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <ObjectRelationPicker
          targetTag={target}
          selected={uris}
          onSelect={(uri) => {
            setOpen(false)
            if (uris.includes(uri)) {
              const next = uris.filter((item) => item !== uri)
              onSave(next.length > 0 ? next : undefined)
            } else {
              onSave(many ? [...uris, uri] : [uri])
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The relation URIs a group stands for. The grouped table keys a group by the
 * stringified cell, so an array of URIs arrives comma-joined.
 */
export function relationGroupUris(value: unknown): string[] | null {
  const parts = typeof value === 'string' ? value.split(',') : isRelationValue(value) ? value : null
  if (!parts || parts.length === 0) return null
  return parts.every((part) => parseRelationUri(part) !== null) ? parts : null
}

/** A group title: relation values read as their objects, not as URIs. */
export function GroupValueTitle({ uris }: { uris: string[] }): React.JSX.Element {
  return <RelationTitles uris={uris} />
}

/** "+ New {tag} in {group}" on a group header of a tag table. */
export function NewInGroupButton({
  property,
  value
}: {
  property: string
  value: unknown
}): React.JSX.Element | null {
  const table = useTagTable()
  if (!table) return null
  return <NewInGroup table={table} property={property} value={value} />
}

function NewInGroup({
  table,
  property,
  value
}: {
  table: TagTableValue
  property: string
  value: unknown
}): React.JSX.Element {
  const { t } = useT('notes')
  const titles = useGroupLabel(value)
  return (
    <button
      type="button"
      data-testid="new-in-group"
      onClick={(event) => {
        event.stopPropagation()
        table.createInGroup(
          property,
          relationGroupUris(value) ?? value,
          event.metaKey || event.ctrlKey
        )
      }}
      onKeyDown={(event) => {
        // F1: ⌘↵ creates in the group and opens the new note in a tab.
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
        event.preventDefault()
        event.stopPropagation()
        table.createInGroup(property, relationGroupUris(value) ?? value, true)
      }}
      title={t('tagObjects.table.newInGroupHint')}
      className="ms-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Plus className="size-3" />
      {titles
        ? t('tagObjects.table.newInGroup', { tag: table.tag.name, group: titles })
        : t('tagObjects.table.new', { tag: table.tag.name })}
    </button>
  )
}

function useGroupLabel(value: unknown): string | null {
  const uris = relationGroupUris(value)
  const refs = useResolvedRefs(uris ?? [])
  if (uris) return refs.map((ref) => ref.title).join(', ') || null
  if (value === null || value === undefined || value === '') return null
  return Array.isArray(value) ? value.map(stringifyUnknown).join(', ') : stringifyUnknown(value)
}

/**
 * F1: "Arriving from Ahmet's Meetings count adds the filter Attendees includes
 * Ahmet. It is a normal filter: remove it, or save it as a view."
 */
export function LinkedFilterBar({
  filter,
  onRemove,
  onSave,
  shown,
  total
}: {
  filter: string
  onRemove: () => void
  onSave: () => void
  shown: number
  total: number
}): React.JSX.Element {
  const { t } = useT('notes')
  const match = /^(.+?)\s+contains\s+"(.+)"$/u.exec(filter)
  const field = match?.[1] ?? filter
  const uri = match?.[2]
  return (
    <div
      className="flex items-center gap-2 border-b border-border px-6 py-2 text-[13px]"
      data-testid="linked-filter-bar"
    >
      <span className="flex items-center gap-1.5 rounded-full border border-border py-0.5 ps-2.5 pe-1 text-muted-foreground">
        {t('tagObjects.table.includes', { field })}
        {uri && <RelationTitles uris={[uri]} />}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('tagObjects.table.removeFilter')}
          className="rounded-full p-0.5 hover:bg-muted"
        >
          <X className="size-3" />
        </button>
      </span>
      <span className="ms-auto text-xs text-muted-foreground">
        {t('tagObjects.table.shown', { shown, total })}
      </span>
      <button
        type="button"
        onClick={onSave}
        className="rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted"
      >
        {t('tagObjects.table.saveView')}
      </button>
    </div>
  )
}

/** AND a linked filter onto a view's own filters (Save view). */
export function withLinkedFilter(
  filters: FilterExpression | undefined,
  linked: string
): FilterExpression {
  return filters ? { and: [filters, linked] } : linked
}

/**
 * F1: "Mentioned in · 9 notes with #meeting in their text" under a tag with
 * fields' table. Notes that carry the tag only inline are labels, not rows.
 */
export function MentionedInSection({
  tag,
  onOpen
}: {
  tag: ResolvedTag
  onOpen: (noteId: string, title: string) => void
}): React.JSX.Element | null {
  const { t } = useT('notes')
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['tags', 'mentioned-in', tag.key],
    queryFn: () =>
      window.api.folderView.listWithProperties({
        scope: { kind: 'tag', tag: tag.key },
        rows: 'mentions',
        limit: 200,
        offset: 0
      })
  })
  const toggle = useCallback(() => setOpen((value) => !value), [])
  const notes = data?.notes ?? []
  if (notes.length === 0) return null
  return (
    <section className="border-t border-border px-6 py-3 text-[13px]" data-testid="mentioned-in">
      <button type="button" onClick={toggle} className="flex items-center gap-2">
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
        <span className="font-medium">{t('tagObjects.linkedHere.mentionedIn')}</span>
        <span className="text-muted-foreground">
          {t('tagObjects.table.mentionedMeta', { count: notes.length, tag: tag.name })}
        </span>
      </button>
      {open && (
        <ul className="mt-2 flex flex-col">
          {notes.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => onOpen(note.id, note.title)}
                className="flex h-8 w-full items-center gap-2 rounded-[5px] ps-6 text-start hover:bg-accent"
              >
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="truncate">{note.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
