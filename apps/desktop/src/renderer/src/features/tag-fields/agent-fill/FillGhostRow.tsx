import { useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedField } from '@memry/contracts/tag-schema'
import type { FieldFillProposal } from '@memry/contracts/tag-fill-api'
import { Check, FileText, Sparkles, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { PROPERTY_TYPE_ICONS } from '@/components/note/info-section/PropertyRow'
import { clearSourceHighlight, highlightSource } from './source-highlight'

export function FillValue({ proposal }: { proposal: FieldFillProposal }) {
  const { t } = useT('notes')
  if (proposal.create) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-dashed border-border px-1.5 py-0.5 text-[12px] text-text-secondary"
        title={t('tagFields.fill.createHint', { tag: proposal.create.tag })}
      >
        <Sparkles className="size-3 shrink-0" aria-hidden />
        {proposal.display}
      </span>
    )
  }
  if (
    Array.isArray(proposal.value) &&
    proposal.value.some((v) => String(v).startsWith('memry://'))
  ) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[12px] text-foreground">
        <FileText className="size-3 shrink-0 text-emerald-600" aria-hidden />
        {proposal.display}
      </span>
    )
  }
  return <span className="block truncate text-[13px] text-foreground">{proposal.display}</span>
}

interface FillGhostRowProps {
  field: ResolvedField
  proposal: FieldFillProposal
  onAccept: () => void
  onReject: () => void
  busy?: boolean
}

export function FillGhostRow({ field, proposal, onAccept, onReject, busy }: FillGhostRowProps) {
  const { t } = useT('notes')
  const rowRef = useRef<HTMLLIElement>(null)
  const Icon = PROPERTY_TYPE_ICONS[field.type]
  const paint = () => highlightSource(rowRef.current, proposal.sourceText)
  return (
    <li
      ref={rowRef}
      className={cn(
        'my-0.5 flex items-center rounded-md border border-transparent bg-surface py-1 ps-1 pe-1',
        'hover:border-tint/40 hover:bg-tint/5 focus-within:border-tint/40 focus-within:bg-tint/5',
        'motion-safe:transition-colors'
      )}
      data-testid="field-fill-proposal"
      onMouseEnter={paint}
      onMouseLeave={clearSourceHighlight}
      onFocus={paint}
      onBlur={clearSourceHighlight}
    >
      <span className="flex h-4 w-5 shrink-0 items-center">
        {Icon && <Icon className="size-3.5 text-text-tertiary" aria-hidden />}
      </span>
      <span className="me-2 w-28 shrink-0 truncate text-[13px] text-text-tertiary">
        {field.name}
      </span>
      <span className="min-w-0 flex-1">
        <FillValue proposal={proposal} />
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onAccept}
        aria-label={t('tagFields.fill.accept', { field: field.name })}
        className="flex size-6 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:opacity-50"
      >
        <Check className="size-3.5" />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onReject}
        aria-label={t('tagFields.fill.reject', { field: field.name })}
        className="ms-1 flex size-6 items-center justify-center rounded-md text-text-tertiary hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <X className="size-3.5" />
      </button>
    </li>
  )
}

export function FillMissingRow({ field }: { field: ResolvedField }) {
  const { t } = useT('notes')
  const Icon = PROPERTY_TYPE_ICONS[field.type]
  return (
    <li className="flex items-center py-1.5 ps-1">
      <span className="flex h-4 w-5 shrink-0 items-center">
        {Icon && <Icon className="size-3.5 text-text-tertiary" aria-hidden />}
      </span>
      <span className="me-2 w-28 shrink-0 truncate text-[13px] text-text-tertiary">
        {field.name}
      </span>
      <span className="text-[13px] text-text-tertiary">{t('tagFields.fill.notInNote')}</span>
    </li>
  )
}
