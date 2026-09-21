import { diffLines, diffWordsWithSpace } from 'diff'
import { useMemo } from 'react'

import type { ChangePreview, ChangePreviewField } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'

/**
 * What a pending agent write would do, in the shape that fits the item.
 *
 * A task moving its due date and a note gaining three paragraphs are not the
 * same picture. Metadata changes get one row per column so the eye lands on the
 * value that moved; markdown gets a word-level diff so a one-word edit in a
 * long note reads as a one-word edit; a delete gets neither, because it has no
 * "after" \u2014 only what the user is about to stop having.
 */
export function ChangePreviewView({
  preview,
  className
}: {
  preview: ChangePreview
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <PreviewHeader preview={preview} />
      {preview.kind === 'body' && preview.body ? <BodyDiff body={preview.body} /> : null}
      {preview.fields.length > 0 ? <FieldRows rows={preview.fields} /> : null}
      {preview.kind === 'loss' ? <LossList entries={preview.loss} /> : null}
      <EmptyNote preview={preview} />
    </div>
  )
}

function PreviewHeader({ preview }: { preview: ChangePreview }): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-text-secondary uppercase">
        {t(`agentChat.preview.item.${preview.item.type}`)}
      </span>
      <span className="min-w-0 truncate text-sm font-medium text-foreground">
        {preview.item.title}
      </span>
      {preview.item.context ? (
        <span className="min-w-0 truncate text-xs text-text-tertiary">{preview.item.context}</span>
      ) : null}
      <span className="text-xs text-text-tertiary">
        {t(`agentChat.preview.intent.${preview.intent}`)}
      </span>
    </div>
  )
}

/**
 * Nothing to show is itself worth saying. A preview with no rows and no body
 * means the write would not move anything the card can name, and silence there
 * reads as a broken preview rather than a harmless write.
 */
function EmptyNote({ preview }: { preview: ChangePreview }): React.JSX.Element | null {
  const { t } = useT('common')
  const hasBody = preview.kind === 'body' && Boolean(preview.body)
  const hasLoss = preview.kind === 'loss'
  if (hasBody || hasLoss || preview.fields.length > 0) return null
  return <p className="text-xs text-text-tertiary">{t('agentChat.preview.noChange')}</p>
}

function FieldRows({ rows }: { rows: ChangePreviewField[] }): React.JSX.Element {
  return (
    <div className="flex flex-col rounded-md bg-muted/60 p-1">
      {rows.map((row) => (
        <FieldRow key={row.key} row={row} />
      ))}
    </div>
  )
}

const FIELD_LABELS: Record<string, string> = {
  archived_at: 'archived',
  completed_at: 'completed',
  due_date: 'due',
  due_time: 'dueTime',
  start_date: 'start',
  duplicate_of: 'duplicateOf',
  is_default: 'isDefault',
  is_done: 'isDone',
  repeat_from: 'repeatFrom',
  snooze_reason: 'snoozeReason',
  snoozed_until: 'snoozedUntil'
}

function FieldRow({ row }: { row: ChangePreviewField }): React.JSX.Element {
  const { t } = useT('common')
  const labelKey = FIELD_LABELS[row.key] ?? row.key
  const label = t(`agentChat.preview.field.${labelKey}`, {
    defaultValue: row.key.replace(/_/g, ' ')
  })

  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
      <span className="w-20 shrink-0 text-xs text-text-tertiary">{label}</span>
      <FieldValue value={row.before} tone="before" />
      <span aria-hidden className="text-xs text-text-tertiary">
        &rarr;
      </span>
      <FieldValue value={row.after} tone="after" />
    </div>
  )
}

/**
 * `null` is rendered as "not set" rather than as a blank, because a blank is
 * indistinguishable from a value the card failed to load.
 */
function FieldValue({
  value,
  tone
}: {
  value: string | null
  tone: 'before' | 'after'
}): React.JSX.Element {
  const { t } = useT('common')

  if (value === null) {
    return <span className="text-xs text-text-tertiary italic">{t('agentChat.preview.unset')}</span>
  }

  const label =
    value === 'true' || value === 'false'
      ? t(`agentChat.preview.${value === 'true' ? 'yes' : 'no'}`)
      : value

  return (
    <span
      className={cn(
        'max-w-[14rem] truncate rounded px-1.5 py-0.5 text-xs',
        tone === 'before'
          ? 'bg-[var(--diff-del-surface)] text-[var(--diff-del)] line-through'
          : 'bg-[var(--diff-add-surface)] font-medium text-[var(--diff-add)]'
      )}
    >
      {label}
    </span>
  )
}

/** `words:42`, `tags:3`, `excerpt:...` — main sends counts, the card names them. */
function LossList({ entries }: { entries: string[] }): React.JSX.Element {
  const { t } = useT('common')
  const parsed = entries.map((entry) => {
    const separator = entry.indexOf(':')
    return separator === -1
      ? { key: 'other', value: entry }
      : { key: entry.slice(0, separator), value: entry.slice(separator + 1) }
  })
  const excerpt = parsed.find((entry) => entry.key === 'excerpt')
  const counts = parsed.filter((entry) => entry.key !== 'excerpt')

  return (
    <div className="flex gap-3 rounded-md bg-muted/60 p-3">
      <div aria-hidden className="w-0.5 shrink-0 rounded bg-destructive" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-[10px] font-semibold tracking-wide text-text-tertiary uppercase">
          {t('agentChat.preview.willBeLost')}
        </p>
        {excerpt ? (
          <p className="line-clamp-3 text-xs leading-relaxed text-text-tertiary">{excerpt.value}</p>
        ) : null}
        {counts.length > 0 ? (
          <p className="text-xs text-text-secondary">
            {counts
              .map((entry) =>
                t(`agentChat.preview.loss.${entry.key}`, {
                  count: Number(entry.value),
                  value: entry.value,
                  defaultValue: `${entry.key}: ${entry.value}`
                })
              )
              .join(' \u00b7 ')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** A run of untouched lines long enough to be worth hiding. */
const CONTEXT_COLLAPSE_LINES = 3

type BodyChunk =
  | { kind: 'context'; text: string }
  | { kind: 'collapsed'; lines: number }
  | { kind: 'changed'; removed: string; added: string }

/**
 * Line diff first, word diff inside each changed hunk.
 *
 * Doing it the other way round \u2014 one word diff over the whole document \u2014 reads
 * fine for a sentence and falls apart for an append, where every untouched
 * paragraph still has to be drawn before the user reaches the new text. Hunks
 * let long untouched runs collapse to a count.
 */
export function buildBodyChunks(current: string, candidate: string): BodyChunk[] {
  const chunks: BodyChunk[] = []
  const changes = diffLines(current, candidate)

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]

    if (!change.added && !change.removed) {
      const lines = change.value.split('\n').filter((line) => line.length > 0).length
      chunks.push(
        lines > CONTEXT_COLLAPSE_LINES
          ? { kind: 'collapsed', lines }
          : { kind: 'context', text: change.value }
      )
      continue
    }

    // A replacement arrives as removed-then-added; pairing them is what makes a
    // word diff possible instead of two opaque blocks.
    const next = changes[index + 1]
    if (change.removed && next?.added) {
      chunks.push({ kind: 'changed', removed: change.value, added: next.value })
      index += 1
      continue
    }

    chunks.push({
      kind: 'changed',
      removed: change.removed ? change.value : '',
      added: change.added ? change.value : ''
    })
  }

  return chunks
}

function BodyDiff({ body }: { body: { current: string; candidate: string } }): React.JSX.Element {
  const { t } = useT('common')
  const chunks = useMemo(() => buildBodyChunks(body.current, body.candidate), [body])

  return (
    <div className="flex max-h-72 flex-col gap-2 overflow-auto rounded-md bg-muted/60 p-3 text-start">
      {chunks.map((chunk, index) => {
        if (chunk.kind === 'collapsed') {
          return (
            <div key={index} className="flex items-center gap-2">
              <div aria-hidden className="h-px grow bg-border" />
              <span className="text-[10px] text-text-tertiary">
                {t('agentChat.preview.unchangedLines', { count: chunk.lines })}
              </span>
              <div aria-hidden className="h-px grow bg-border" />
            </div>
          )
        }

        if (chunk.kind === 'context') {
          return (
            <p
              key={index}
              className="text-xs leading-relaxed whitespace-pre-wrap text-text-tertiary"
            >
              {chunk.text.replace(/\n+$/, '')}
            </p>
          )
        }

        return <ChangedChunk key={index} removed={chunk.removed} added={chunk.added} />
      })}
    </div>
  )
}

function ChangedChunk({ removed, added }: { removed: string; added: string }): React.JSX.Element {
  const tokens = useMemo(() => {
    if (!removed) return [{ value: added, added: true, removed: false }]
    if (!added) return [{ value: removed, added: false, removed: true }]
    return diffWordsWithSpace(removed, added)
  }, [removed, added])

  return (
    <p className="text-xs leading-relaxed whitespace-pre-wrap text-text-secondary">
      {tokens.map((token, index) => {
        if (token.added) {
          return (
            <ins
              key={index}
              className="rounded bg-[var(--diff-add-surface)] px-0.5 font-medium text-[var(--diff-add)] no-underline"
            >
              {token.value}
            </ins>
          )
        }
        if (token.removed) {
          return (
            <del
              key={index}
              className="rounded bg-[var(--diff-del-surface)] px-0.5 text-[var(--diff-del)]"
            >
              {token.value}
            </del>
          )
        }
        return <span key={index}>{token.value}</span>
      })}
    </p>
  )
}
