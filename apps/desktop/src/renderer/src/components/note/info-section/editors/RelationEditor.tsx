import { useEffect, useState } from 'react'
import {
  FileText,
  CheckSquare,
  Calendar,
  PenTool,
  BookOpen,
  Plus,
  X,
  type AppIcon
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { propertiesService, type ResolvedRelationRef } from '@/services/properties-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { RelationKind } from '@memry/contracts/properties-api'
import { useT } from '@memry/i18n/renderer'
import { useRelationNavigation } from '@/hooks/use-relation-navigation'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { ObjectAvatar } from '@/features/tag-fields/object-avatar'
import { useRelationDrop } from '@/features/tag-fields/relation-drop'
import { useOptionalTagSchemaSnapshot } from '@/features/tag-fields/use-optional-object-identity'
import { objectIdentityOf } from '@/features/tag-fields/use-tag-schemas'
import { RelationPicker } from './RelationPicker'

const log = createLogger('RelationEditor')

const KIND_ICONS: Record<RelationKind, AppIcon> = {
  note: FileText,
  task: CheckSquare,
  event: Calendar,
  canvas: PenTool,
  journal: BookOpen
}

interface RelationEditorProps {
  value: string[]
  onChange: (next: string[]) => void
  targetTag?: string | null
  many?: boolean
}

// Renders live-resolved chips for a relation property's stored URIs, plus a
// "+" trigger that opens the write-side picker (RelationPicker). Never
// stores a title on a chip — that's the point of the ID-based design,
// renaming a target requires zero writes here. Dangling refs (exists: false)
// render as a distinct "deleted" chip and are never auto-scrubbed from the
// value; only an explicit remove click writes.
export function RelationEditor({ value, onChange, targetTag, many = true }: RelationEditorProps) {
  const { t } = useT('notes')
  const navigate = useRelationNavigation()
  const snapshot = useOptionalTagSchemaSnapshot()
  const [resolved, setResolved] = useState<ResolvedRelationRef[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    // Nothing to resolve. `resolved` is left untouched here on purpose — the
    // render below derives the empty case straight from `value` instead of
    // resetting state in response to a prop change, so a stale `resolved`
    // from a prior non-empty value never leaks through.
    if (value.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        const refs = await propertiesService.resolveRefs(value)
        if (!cancelled) setResolved(refs)
      } catch (err) {
        log.error('Failed to resolve relation refs:', extractErrorMessage(err))
        if (!cancelled) setResolved([])
      }
    })()

    return () => {
      cancelled = true
    }
  }, [value])

  const handleRemove = (uri: string) => {
    onChange(value.filter((v) => v !== uri))
  }

  // The property_refs primary key would reject a duplicate row downstream,
  // and silently emitting a no-op change would still dirty the note — so a
  // URI already in the value is a no-op here, before onChange ever fires.
  const handleSelect = (uri: string) => {
    if (value.includes(uri)) return
    onChange(many ? [...value, uri] : [uri])
    setPickerOpen(false)
  }

  const drop = useRelationDrop({ targetTag, snapshot, onLink: handleSelect })

  const chips = value.length === 0 ? [] : resolved

  return (
    <div
      {...drop.dropProps}
      className={cn('flex flex-wrap items-center gap-1 rounded', drop.isOver && 'ring-1 ring-tint')}
    >
      {drop.dialog}
      {chips.map((ref) => {
        const Icon = KIND_ICONS[ref.targetType]
        const label = ref.exists ? ref.title : t('properties.relation.deleted')

        // An object (G1, E1) draws its avatar or tag tile in its tag colour. A
        // note's own emoji stands in for the generic kind icon. Only markdown
        // notes carry one; files, tasks and events keep their kind icon.
        const identity =
          ref.exists && ref.targetType === 'note' ? objectIdentityOf(snapshot, ref.targetId) : null
        const objectColor = identity ? getTagColors(identity.color, identity.tag).text : null
        const glyph =
          identity && !ref.emoji ? (
            <ObjectAvatar look={identity} title={label} size={16} />
          ) : ref.emoji ? (
            <span className="size-3 shrink-0 leading-none text-[11px]" aria-hidden>
              <NoteIconDisplay value={ref.emoji} />
            </span>
          ) : (
            <Icon className="size-3 shrink-0" aria-hidden />
          )

        return (
          <span
            key={ref.uri}
            data-testid={ref.exists ? 'relation-chip' : 'relation-chip-deleted'}
            className={cn(
              'group/chip [font-synthesis:none] inline-flex items-center gap-1',
              'rounded-[10px] ps-1.5 pe-1 py-0.5',
              'text-[11px]/3.5 font-medium',
              'shrink-0 select-none max-w-full',
              objectColor
                ? 'ps-0.5 text-foreground'
                : ref.exists
                  ? 'bg-tint/10 text-tint'
                  : 'bg-muted text-muted-foreground'
            )}
            style={objectColor ? { backgroundColor: withAlpha(objectColor, 0.1) } : undefined}
          >
            {/* A dangling ref has nothing to open, so it stays inert text.
                The remove control is a sibling, never nested inside this
                button — a button inside a button is invalid markup. */}
            {ref.exists ? (
              <button
                type="button"
                onClick={() => navigate(ref)}
                title={ref.title}
                className={cn(
                  'inline-flex min-w-0 items-center gap-1 rounded-[8px]',
                  'transition-opacity duration-150 hover:opacity-80',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                )}
              >
                {glyph}
                <span className="truncate">{label}</span>
              </button>
            ) : (
              <>
                {glyph}
                <span className="truncate">{label}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => handleRemove(ref.uri)}
              aria-label={t('properties.relation.removeAria', { title: label })}
              className={cn(
                'flex size-3.5 shrink-0 items-center justify-center rounded-full',
                objectColor && 'hidden group-focus-within/chip:flex group-hover/chip:flex',
                'transition-colors duration-150',
                // main.css clears the global focus-visible outline, so every
                // focusable control has to draw its own ring.
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                ref.exists ? 'hover:bg-tint/20' : 'hover:bg-muted-foreground/20'
              )}
            >
              <X className="size-2.5" />
            </button>
          </span>
        )
      })}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('properties.relation.addAria')}
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full',
              'border-[1.5px] border-dashed border-border text-text-tertiary',
              'transition-colors duration-150',
              'hover:border-muted-foreground hover:text-muted-foreground',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            )}
          >
            <Plus className="size-3" strokeWidth={2.5} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-auto p-0">
          <RelationPicker onSelect={handleSelect} targetTag={targetTag} selected={value} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
