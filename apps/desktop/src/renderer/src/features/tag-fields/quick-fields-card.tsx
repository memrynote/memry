import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedField } from '@memry/contracts/tag-schema'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { propertiesService } from '@/services/properties-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ObjectAvatar, type ObjectLook } from './object-avatar'
import { ObjectRelationPicker } from './object-relation-picker'
import { RelationTitles } from './relation-titles'

/** Field types the card can take a first value for without a dedicated editor. */
const QUICK_TYPES = new Set(['text', 'number', 'url', 'relation'])

export function quickFields(fields: readonly ResolvedField[]): ResolvedField[] {
  return fields.filter((field) => QUICK_TYPES.has(field.type)).slice(0, 2)
}

export interface QuickFieldsTarget {
  noteId: string
  title: string
  tag: string
  tagName: string
  look: ObjectLook
  fields: ResolvedField[]
  position: { x: number; y: number }
}

type Values = Record<string, string | string[]>

/** Only typed values: an empty field writes nothing. */
export function quickFieldValues(
  fields: readonly ResolvedField[],
  values: Values
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = values[field.name]
    if (Array.isArray(value)) {
      if (value.length > 0)
        out[field.name] = field.relation?.many === false ? value.slice(-1) : value
    } else if (typeof value === 'string' && value.trim() !== '') {
      out[field.name] = field.type === 'number' ? Number(value) : value.trim()
    }
  }
  return out
}

/**
 * D2 panel 2: right after an @ create, the first two fields of the new object.
 * Tab moves between them; Esc keeps the object with empty fields; ↵ writes the
 * typed values once through properties:set.
 */
export function QuickFieldsCard({
  target,
  onClose
}: {
  target: QuickFieldsTarget
  onClose: () => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const [values, setValues] = useState<Values>({})
  const firstRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  const done = async (): Promise<void> => {
    const typed = quickFieldValues(target.fields, values)
    onClose()
    if (Object.keys(typed).length === 0) return
    try {
      const current = await propertiesService.get(target.noteId)
      const record: Record<string, unknown> = {}
      for (const property of current) record[property.name] = property.value
      const result = await propertiesService.set(target.noteId, { ...record, ...typed })
      if (!result.success) throw new Error(result.error)
    } catch (error) {
      toast.error(extractErrorMessage(error, t('tagObjects.quickFields.saveFailed')))
    }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (
      event.key === 'Enter' &&
      !event.defaultPrevented &&
      event.currentTarget.contains(event.target as Node)
    ) {
      event.preventDefault()
      event.stopPropagation()
      void done()
    }
  }

  return (
    <div
      data-inline-choice-menu
      data-testid="quick-fields-card"
      role="dialog"
      aria-label={t('tagObjects.quickFields.aria', { title: target.title })}
      onKeyDown={onKeyDown}
      className="absolute z-50 flex w-[300px] flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-[13px] shadow-[var(--shadow-card-hover)] motion-safe:animate-in motion-safe:fade-in-0"
      style={{ left: target.position.x, top: target.position.y }}
    >
      <div className="flex items-center gap-2">
        <ObjectAvatar look={target.look} title={target.title} size={24} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground">{target.title}</span>
          <span className="text-xs text-muted-foreground">
            {t('tagObjects.quickFields.newObject', { tag: target.tagName })}
          </span>
        </div>
      </div>
      {target.fields.map((field, index) => (
        <label key={field.name} className="flex items-center gap-2">
          <span className="w-[72px] shrink-0 truncate text-muted-foreground">{field.name}</span>
          {field.relation?.target ? (
            <RelationField
              field={field}
              value={(values[field.name] as string[] | undefined) ?? []}
              onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
              triggerRef={index === 0 ? firstRef : undefined}
            />
          ) : (
            <input
              ref={index === 0 ? (el) => void (firstRef.current = el) : undefined}
              value={(values[field.name] as string | undefined) ?? ''}
              type={field.type === 'number' ? 'number' : 'text'}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
              }
              placeholder={t('tagObjects.quickFields.add', { field: field.name.toLowerCase() })}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 outline-none focus:border-foreground/40"
            />
          )}
        </label>
      ))}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <button type="button" onClick={onClose} className="flex items-center gap-1">
          <kbd className="rounded border border-border px-1">{t('tagObjects.keys.esc')}</kbd>
          {t('tagObjects.quickFields.later')}
        </button>
        <button type="button" onClick={() => void done()} className="flex items-center gap-1">
          <kbd className="rounded border border-border px-1">{t('tagObjects.keys.enter')}</kbd>
          {t('tagObjects.quickFields.done')}
        </button>
      </div>
    </div>
  )
}

function RelationField({
  field,
  value,
  onChange,
  triggerRef
}: {
  field: ResolvedField
  value: string[]
  onChange: (next: string[]) => void
  triggerRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { t } = useT('notes')
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={(el) => {
            if (triggerRef) triggerRef.current = el
          }}
          type="button"
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md border border-border px-2 text-start outline-none focus:border-foreground/40',
            value.length === 0 && 'text-muted-foreground/70'
          )}
        >
          {value.length > 0 ? (
            <RelationTitles uris={value} />
          ) : (
            t('tagObjects.quickFields.add', { field: field.name.toLowerCase() })
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-auto p-0">
        <ObjectRelationPicker
          targetTag={field.relation!.target!}
          selected={value}
          onSelect={(uri) => {
            onChange(field.relation?.many ? [...new Set([...value, uri])] : [uri])
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
