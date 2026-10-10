import { tagKey as keyOf } from '@memry/shared/tag-fold'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { useT } from '@memry/i18n/renderer'
import type { RelationConfig, ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import { ArrowUpRight, GripVertical, Lock, MoreHorizontal, Pencil, Tag, Trash2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useEditTagSchema } from '../use-tag-schemas'
import { FIELD_TYPE_ICONS, fieldTypeLabelKey } from './field-types'
import { RemoveFieldDialog, RenameFieldDialog } from './FieldImpactDialogs'
import { RelationFieldCard } from './RelationFieldCard'
import { TagChip } from './TagChip'

interface FieldListEditorProps {
  tagKey: string
  tag: ResolvedTag | null
}

type FieldAction = { kind: 'rename' | 'remove' | 'relation'; field: ResolvedField } | null

export function FieldListEditor({ tagKey, tag }: FieldListEditorProps): React.JSX.Element {
  const { t } = useT('notes')
  const editSchema = useEditTagSchema()
  const [action, setAction] = useState<FieldAction>(null)
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const editable = tag?.editable ?? true
  const inheritedGroups = useMemo(() => {
    const groups: Array<{ from: string; fields: ResolvedField[] }> = []
    for (const field of tag?.effectiveFields ?? []) {
      if (field.definedBy === tagKey) continue
      const last = groups.at(-1)
      if (last?.from === field.definedBy) last.fields.push(field)
      else groups.push({ from: field.definedBy, fields: [field] })
    }
    return groups
  }, [tag, tagKey])
  const ownFields = useMemo(() => {
    const own = tag?.ownFields ?? []
    if (!pendingOrder) return own
    return pendingOrder
      .map((name) => own.find((field) => field.name === name))
      .filter((field): field is ResolvedField => field !== undefined)
  }, [tag, pendingOrder])
  const taken = useMemo(
    () => new Set((tag?.effectiveFields ?? []).map((field) => field.name.toLowerCase())),
    [tag]
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const names = ownFields.map((field) => field.name)
    const from = names.indexOf(String(active.id))
    const to = names.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    setPendingOrder(arrayMove(names, from, to))
    editSchema({ kind: 'move-field', tag: tagKey, name: String(active.id), toIndex: to })
      .catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('tagFields.settings.errors.moveField')))
      })
      .finally(() => setPendingOrder(null))
  }

  const saveRelation = async (field: ResolvedField, relation: RelationConfig): Promise<void> => {
    try {
      await editSchema({ kind: 'set-relation', tag: tagKey, name: field.name, relation })
      setAction(null)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.relation')))
    }
  }

  const empty = inheritedGroups.length === 0 && ownFields.length === 0

  return (
    <>
      {empty ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-text-tertiary">
          {t('tagFields.settings.fields.empty')}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {inheritedGroups.map((group) => (
            <div key={group.from} className="border-b last:border-b-0">
              <div className="flex items-center gap-1.5 bg-muted/60 px-3 py-1.5 text-xs text-text-tertiary">
                <Tag className="size-3" />
                {t('tagFields.settings.fields.fromParent', { tag: group.from })}
              </div>
              {group.fields.map((field) => (
                <FieldRow key={field.name} field={field} locked />
              ))}
            </div>
          ))}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={ownFields.map((field) => field.name)}
              strategy={verticalListSortingStrategy}
            >
              {ownFields.map((field) => (
                <SortableFieldRow
                  key={field.name}
                  field={field}
                  disabled={!editable}
                  onAction={(kind) => setAction({ kind, field })}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {action?.kind === 'remove' && (
        <RemoveFieldDialog
          tag={tagKey}
          field={action.field.name}
          open
          onOpenChange={(open) => !open && setAction(null)}
        />
      )}
      {action?.kind === 'rename' && (
        <RenameFieldDialog
          field={action.field.name}
          taken={new Set([...taken].filter((name) => name !== action.field.name.toLowerCase()))}
          open
          onOpenChange={(open) => !open && setAction(null)}
        />
      )}
      {action?.kind === 'relation' && (
        <Dialog open onOpenChange={(open) => !open && setAction(null)}>
          <DialogContent className="max-w-[340px] p-4">
            <DialogTitle className="sr-only">
              {t('tagFields.settings.fields.relationSettings')}
            </DialogTitle>
            <RelationFieldCard
              name={action.field.name}
              tagName={tag?.name ?? tagKey}
              initial={action.field.relation}
              submitLabel={t('tagFields.settings.save')}
              onCancel={() => setAction(null)}
              onSubmit={(relation) => saveRelation(action.field, relation)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

interface SortableFieldRowProps {
  field: ResolvedField
  disabled: boolean
  onAction: (kind: 'rename' | 'remove' | 'relation') => void
}

function SortableFieldRow({ field, disabled, onAction }: SortableFieldRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.name,
    disabled
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative bg-background', isDragging && 'z-10 shadow-md')}
    >
      <FieldRow
        field={field}
        locked={false}
        dragHandle={
          <button
            type="button"
            className="flex size-4 shrink-0 cursor-grab items-center justify-center text-text-tertiary active:cursor-grabbing disabled:cursor-default"
            disabled={disabled}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        menu={disabled ? null : <FieldRowMenu field={field} onAction={onAction} />}
      />
    </div>
  )
}

interface FieldRowProps {
  field: ResolvedField
  locked: boolean
  dragHandle?: React.ReactNode
  menu?: React.ReactNode
}

function FieldRow({ field, locked, dragHandle, menu }: FieldRowProps): React.JSX.Element {
  const { t } = useT('notes')
  const { tags } = useNoteTagsQuery()
  const Icon = FIELD_TYPE_ICONS[field.type]
  const target = field.relation?.target ?? null
  const targetRow = target ? tags.find((row) => keyOf(row.tag) === keyOf(target)) : undefined

  return (
    <div
      className={cn(
        'group flex min-h-10 items-center gap-2.5 border-b px-3 py-2 last:border-b-0',
        locked && 'text-text-tertiary'
      )}
    >
      {locked ? <Lock className="size-3.5 shrink-0" /> : dragHandle}
      <Icon className={cn('size-3.5 shrink-0', !locked && 'text-text-secondary')} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-sm', !locked && 'font-medium text-foreground')}>
          {field.name}
        </span>
        {field.relation && !locked && (
          <span className="truncate text-xs text-text-tertiary">
            {target
              ? t('tagFields.settings.fields.inverseSub', {
                  target,
                  inverse: field.relation.inverse ?? field.definedBy
                })
              : t('tagFields.settings.fields.anyNoteSub')}
          </span>
        )}
      </div>
      {target && (
        <TagChip
          name={targetRow?.tag ?? target}
          color={targetRow?.color ?? ''}
          icon={targetRow?.icon ?? null}
          className="max-w-[120px] shrink-0"
        />
      )}
      <span className="shrink-0 text-xs text-text-tertiary">
        {t(fieldTypeLabelKey(field.type))}
      </span>
      {menu}
    </div>
  )
}

function FieldRowMenu({
  field,
  onAction
}: {
  field: ResolvedField
  onAction: (kind: 'rename' | 'remove' | 'relation') => void
}): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="-me-1.5 size-6 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label={t('tagFields.settings.fields.actions', { field: field.name })}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => onAction('rename')}>
          <Pencil className="me-2 size-4" />
          {t('tagFields.settings.fields.rename')}
        </DropdownMenuItem>
        {field.relation && (
          <DropdownMenuItem onClick={() => onAction('relation')}>
            <ArrowUpRight className="me-2 size-4" />
            {t('tagFields.settings.fields.relationSettings')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onAction('remove')}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="me-2 size-4" />
          {t('tagFields.settings.fields.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
