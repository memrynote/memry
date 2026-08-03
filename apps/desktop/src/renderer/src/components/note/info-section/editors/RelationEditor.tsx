import { useEffect, useState } from 'react'
import { FileText, CheckSquare, Calendar, X, type AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { propertiesService, type ResolvedRelationRef } from '@/services/properties-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { RelationKind } from '@memry/contracts/properties-api'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('RelationEditor')

const KIND_ICONS: Record<RelationKind, AppIcon> = {
  note: FileText,
  task: CheckSquare,
  event: Calendar
}

interface RelationEditorProps {
  value: string[]
  onChange: (next: string[]) => void
}

// Read side only: renders live-resolved chips for a relation property's
// stored URIs. Never stores a title — that's the point of the ID-based
// design, renaming a target requires zero writes here. Dangling refs
// (exists: false) render as a distinct "deleted" chip and are never
// auto-scrubbed from the value; only an explicit remove click writes.
export function RelationEditor({ value, onChange }: RelationEditorProps) {
  const { t } = useT('notes')
  const [resolved, setResolved] = useState<ResolvedRelationRef[]>([])

  useEffect(() => {
    // Nothing to resolve — and the component renders null for an empty
    // value below, so `resolved` is moot either way.
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

  if (value.length === 0) {
    return null
  }

  const handleRemove = (uri: string) => {
    onChange(value.filter((v) => v !== uri))
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {resolved.map((ref) => {
        const Icon = KIND_ICONS[ref.targetType]
        const label = ref.exists ? ref.title : t('properties.relation.deleted')

        return (
          <span
            key={ref.uri}
            data-testid={ref.exists ? 'relation-chip' : 'relation-chip-deleted'}
            className={cn(
              '[font-synthesis:none] inline-flex items-center gap-1',
              'rounded-[10px] ps-1.5 pe-1 py-0.5',
              'text-[11px]/3.5 font-medium',
              'shrink-0 select-none max-w-full',
              ref.exists ? 'bg-tint/10 text-tint' : 'bg-muted text-muted-foreground'
            )}
          >
            <Icon className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
            <button
              type="button"
              onClick={() => handleRemove(ref.uri)}
              aria-label={t('properties.relation.removeAria', { title: label })}
              className={cn(
                'flex size-3.5 shrink-0 items-center justify-center rounded-full',
                'transition-colors duration-150',
                ref.exists ? 'hover:bg-tint/20' : 'hover:bg-muted-foreground/20'
              )}
            >
              <X className="size-2.5" />
            </button>
          </span>
        )
      })}
    </div>
  )
}
