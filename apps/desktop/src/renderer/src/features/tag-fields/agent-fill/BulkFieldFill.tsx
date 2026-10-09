import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { FieldFillProposal } from '@memry/contracts/tag-fill-api'
import { Check, Sparkles, X } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { tagsService } from '@/services/tags-service'
import { isFilledValue } from '../build-field-groups'
import { FillDisclosure } from './FillDisclosure'
import { FillValue } from './FillGhostRow'
import { writeProposals } from './fill-writes'
import { useFillStatus } from './use-fill-status'

export interface BulkFillNote {
  id: string
  title: string
  properties: Record<string, unknown>
}

interface FoundRow {
  noteId: string
  title: string
  proposals: FieldFillProposal[]
}

type Phase = 'idle' | 'disclosure' | 'running' | 'done'

const MAX_COLUMNS = 3

function fillable(field: ResolvedField): boolean {
  return field.type !== 'checkbox' && (field.type !== 'relation' || !!field.relation?.target)
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('')
}

export function BulkFieldFill({ tag, notes }: { tag: ResolvedTag; notes: BulkFillNote[] }) {
  const { t } = useT('notes')
  const { status, visible, refresh } = useFillStatus()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [rows, setRows] = useState<FoundRow[]>([])
  const [oneByOne, setOneByOne] = useState(false)
  const [busy, setBusy] = useState(false)
  const stopRef = useRef(false)

  const fields = useMemo(() => tag.effectiveFields.filter(fillable), [tag])
  const candidates = useMemo(
    () => notes.filter((note) => fields.some((f) => !isFilledValue(note.properties[f.name]))),
    [notes, fields]
  )
  const columns = useMemo(() => {
    const found = new Set(rows.flatMap((row) => row.proposals.map((p) => p.field)))
    const withValues = fields.filter((field) => found.has(field.name))
    return (withValues.length > 0 ? withValues : fields).slice(0, MAX_COLUMNS)
  }, [rows, fields])
  const foundCount = rows.reduce((sum, row) => sum + row.proposals.length, 0)

  if (!visible || fields.length === 0 || candidates.length === 0) return null

  const run = async (acceptDisclosure: boolean) => {
    stopRef.current = false
    setRows([])
    setOneByOne(false)
    setPhase('running')
    setProgress({ done: 0, total: candidates.length })
    let accepted = acceptDisclosure
    for (const [index, note] of candidates.entries()) {
      if (stopRef.current) break
      try {
        const result = await tagsService.fillFields({
          noteId: note.id,
          tag: tag.key,
          acceptDisclosure: accepted
        })
        if (accepted) {
          accepted = false
          refresh()
        }
        if (result.kind === 'unavailable' || result.kind === 'disclosure-required') break
        if (result.kind === 'failed') {
          toast.error(t('tagFields.fill.failed', { message: result.message }))
          break
        }
        if (result.proposals.length > 0) {
          setRows((prev) => [
            ...prev,
            { noteId: note.id, title: note.title, proposals: result.proposals }
          ])
        }
      } catch (err) {
        toast.error(extractErrorMessage(err, t('tagFields.fill.failed', { message: '' })))
        break
      }
      setProgress({ done: index + 1, total: candidates.length })
    }
    setPhase('done')
  }

  const start = () => {
    setOpen(true)
    if (status && !status.disclosureAccepted) setPhase('disclosure')
    else void run(false)
  }

  const acceptRows = async (accepted: FoundRow[]) => {
    setBusy(true)
    let written = 0
    try {
      for (const row of accepted) {
        await writeProposals(row.noteId, row.proposals)
        written += row.proposals.length
        setRows((prev) => prev.filter((r) => r.noteId !== row.noteId))
      }
      if (accepted.length > 1) {
        toast(
          t(written === 1 ? 'tagFields.fill.bulkSavedOne' : 'tagFields.fill.bulkSaved', {
            count: written,
            notes: accepted.length
          })
        )
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.fill.saveFailed')))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    stopRef.current = true
    setOpen(false)
    setPhase('idle')
    setRows([])
  }

  const running = phase === 'running'
  const percent = progress.total > 0 ? (progress.done / progress.total) * 100 : 0

  return (
    <Popover open={open} onOpenChange={(next) => (next ? start() : close())}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" data-testid="bulk-field-fill">
          <Sparkles className="size-3.5" />
          {t('tagFields.fill.bulkAction')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] overflow-hidden p-0">
        <div className="flex items-start gap-3 px-3.5 pb-2.5 pt-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] font-semibold text-foreground">
              {t('tagFields.fill.bulkTitle')}
            </span>
            {phase !== 'disclosure' && (
              <span className="text-[12px] text-text-tertiary">
                {t(running ? 'tagFields.fill.bulkReading' : 'tagFields.fill.bulkRead', {
                  done: progress.done,
                  total: progress.total
                })}
              </span>
            )}
          </div>
          {running && (
            <Button variant="outline" size="sm" onClick={() => (stopRef.current = true)}>
              {t('tagFields.fill.stop')}
            </Button>
          )}
        </div>
        {phase === 'disclosure' && status ? (
          <div className="px-3.5 pb-3.5">
            <FillDisclosure
              model={status.model}
              local={status.local}
              many
              onAccept={() => void run(true)}
              onDecline={close}
            />
          </div>
        ) : (
          <>
            <div className="h-[3px] bg-surface" aria-hidden>
              <div
                className="h-full bg-tint motion-safe:transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            {rows.length > 0 && (
              <table className="w-full table-fixed text-start text-[13px]">
                <thead>
                  <tr className="border-b border-border text-[12px] text-text-tertiary">
                    <th className="w-[34%] px-3 py-2 text-start font-normal">
                      {t('tagFields.fill.name')}
                    </th>
                    {columns.map((field) => (
                      <th key={field.name} className="px-2 py-2 text-start font-normal">
                        <span className="block truncate">{field.name}</span>
                      </th>
                    ))}
                    {oneByOne && <th className="w-16" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.noteId} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2 truncate">
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-tint/15 text-[9px] font-semibold text-tint">
                            {initials(row.title)}
                          </span>
                          <span className="truncate">{row.title}</span>
                        </span>
                      </td>
                      {columns.map((field) => {
                        const proposal = row.proposals.find((p) => p.field === field.name)
                        return (
                          <td key={field.name} className="overflow-hidden px-2 py-2">
                            {proposal ? (
                              <FillValue proposal={proposal} />
                            ) : (
                              <span className="text-[12px] text-text-tertiary">
                                {t('tagFields.fill.nothingInRow')}
                              </span>
                            )}
                          </td>
                        )
                      })}
                      {oneByOne && (
                        <td className="pe-2">
                          <span className="flex justify-end gap-1">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void acceptRows([row])}
                              aria-label={t('tagFields.fill.acceptRow', { title: row.title })}
                              className="flex size-6 items-center justify-center rounded-md border border-border hover:bg-muted"
                            >
                              <Check className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setRows((prev) => prev.filter((r) => r.noteId !== row.noteId))
                              }
                              aria-label={t('tagFields.fill.rejectRow', { title: row.title })}
                              className="flex size-6 items-center justify-center rounded-md text-text-tertiary hover:bg-muted"
                            >
                              <X className="size-3.5" />
                            </button>
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div
              className={cn(
                'flex items-center gap-2 bg-surface px-3.5 py-2.5',
                rows.length > 0 && 'border-t border-border'
              )}
            >
              <span className="me-auto text-[12px] text-text-tertiary">
                {t('tagFields.fill.found', { count: foundCount })}
              </span>
              {!running && rows.length > 0 && !oneByOne && (
                <Button variant="outline" size="sm" onClick={() => setOneByOne(true)}>
                  {t('tagFields.fill.reviewOneByOne')}
                </Button>
              )}
              {rows.length > 0 && (
                <Button size="sm" disabled={running || busy} onClick={() => void acceptRows(rows)}>
                  {t('tagFields.fill.acceptAll')}
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
