/**
 * "Fill from note" on a note's field groups (I1 · 1 and 2). The model's
 * answers are ghost values; nothing is saved until the user accepts one
 * (✓), all (⌘↵) or dismisses them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { FieldFillProposal } from '@memry/contracts/tag-fill-api'
import { Loader2, Sparkles } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { tagsService } from '@/services/tags-service'
import type { FieldGroup, FieldSlot } from '../build-field-groups'
import { isFilledValue } from '../build-field-groups'
import { FillDisclosure } from './FillDisclosure'
import { FillGhostRow, FillMissingRow } from './FillGhostRow'
import { writeProposals } from './fill-writes'
import { clearSourceHighlight } from './source-highlight'
import { useFillStatus } from './use-fill-status'

type Phase =
  | { kind: 'idle' }
  | { kind: 'disclosure'; group: string; tag: string; model: string; local: boolean }
  | { kind: 'loading'; group: string }
  | { kind: 'review'; group: string; proposals: FieldFillProposal[]; busy: boolean }

const groupKey = (group: FieldGroup): string => `${group.tag.key}:${group.via?.key ?? ''}`
/** The header tag the group belongs to: an inherited group fills through its child. */
const headerTagOf = (group: FieldGroup): string => (group.via ?? group.tag).key

export interface NoteFieldFill {
  renderGroupAction: (group: FieldGroup) => React.ReactNode
  renderSlot: (group: FieldGroup, slot: FieldSlot) => React.ReactNode
  renderGroupFooter: (group: FieldGroup) => React.ReactNode
}

export function useNoteFieldFill(noteId: string | null, disabled: boolean): NoteFieldFill {
  const { t } = useT('notes')
  const { status, visible, refresh } = useFillStatus()
  const [state, setState] = useState<{ noteId: string | null; phase: Phase }>({
    noteId,
    phase: { kind: 'idle' }
  })
  // Another note in this pane starts clean.
  const phase = useMemo<Phase>(
    () => (state.noteId === noteId ? state.phase : { kind: 'idle' }),
    [state, noteId]
  )
  const setPhase = useCallback(
    (next: Phase) => {
      // A proposal row that goes away never gets its mouseleave.
      clearSourceHighlight()
      setState({ noteId, phase: next })
    },
    [noteId]
  )

  const run = useCallback(
    async (group: string, tag: string, acceptDisclosure: boolean) => {
      if (!noteId) return
      setPhase({ kind: 'loading', group })
      try {
        const result = await tagsService.fillFields({ noteId, tag, acceptDisclosure })
        if (acceptDisclosure) refresh()
        switch (result.kind) {
          case 'disclosure-required':
            setPhase({ kind: 'disclosure', group, tag, model: result.model, local: result.local })
            return
          case 'unavailable':
            refresh()
            setPhase({ kind: 'idle' })
            return
          case 'failed':
            toast.error(t('tagFields.fill.failed', { message: result.message }))
            setPhase({ kind: 'idle' })
            return
          case 'proposals':
            if (result.proposals.length === 0) {
              toast(t('tagFields.fill.nothingFound'))
              setPhase({ kind: 'idle' })
              return
            }
            setPhase({ kind: 'review', group, proposals: result.proposals, busy: false })
        }
      } catch (err) {
        toast.error(extractErrorMessage(err, t('tagFields.fill.failed', { message: '' })))
        setPhase({ kind: 'idle' })
      }
    },
    [noteId, refresh, setPhase, t]
  )

  const start = useCallback(
    (group: FieldGroup) => {
      const key = groupKey(group)
      const tag = headerTagOf(group)
      if (status && !status.disclosureAccepted) {
        setPhase({ kind: 'disclosure', group: key, tag, model: status.model, local: status.local })
        return
      }
      void run(key, tag, false)
    },
    [run, setPhase, status]
  )

  const accept = useCallback(
    async (accepted: FieldFillProposal[]) => {
      if (phase.kind !== 'review' || !noteId) return
      setPhase({ ...phase, busy: true })
      try {
        await writeProposals(noteId, accepted)
        const rest = phase.proposals.filter((p) => !accepted.includes(p))
        setPhase(rest.length > 0 ? { ...phase, proposals: rest, busy: false } : { kind: 'idle' })
      } catch (err) {
        toast.error(extractErrorMessage(err, t('tagFields.fill.saveFailed')))
        setPhase({ ...phase, busy: false })
      }
    },
    [noteId, phase, setPhase, t]
  )

  const reject = useCallback(
    (proposal: FieldFillProposal) => {
      if (phase.kind !== 'review') return
      const rest = phase.proposals.filter((p) => p !== proposal)
      setPhase(rest.length > 0 ? { ...phase, proposals: rest } : { kind: 'idle' })
    },
    [phase, setPhase]
  )

  const reviewing = phase.kind === 'review'
  const acceptAll = useCallback(() => {
    if (phase.kind === 'review' && !phase.busy) void accept(phase.proposals)
  }, [accept, phase])

  useEffect(() => {
    if (!reviewing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      acceptAll()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewing, acceptAll])

  useEffect(() => clearSourceHighlight, [])

  const renderGroupAction = (group: FieldGroup): React.ReactNode => {
    if (!visible || disabled) return null
    const key = groupKey(group)
    if (phase.kind === 'review' && phase.group === key) {
      return (
        <>
          <span className="text-[12px] text-text-tertiary">
            {t(phase.proposals.length === 1 ? 'tagFields.fill.countOne' : 'tagFields.fill.count', {
              count: phase.proposals.length
            })}
          </span>
          <button
            type="button"
            onClick={() => setPhase({ kind: 'idle' })}
            className="rounded-md px-2 py-0.5 text-[12px] text-text-secondary hover:bg-muted"
          >
            {t('tagFields.fill.dismiss')}
          </button>
          <button
            type="button"
            disabled={phase.busy}
            onClick={acceptAll}
            className="flex items-center gap-1.5 rounded-md bg-foreground px-2 py-0.5 text-[12px] font-medium text-background disabled:opacity-60"
          >
            {t('tagFields.fill.acceptAll')}
            <kbd className="font-sans text-[10px] opacity-70">⌘↵</kbd>
          </button>
        </>
      )
    }
    if (phase.kind === 'loading' && phase.group === key) {
      return (
        <span className="flex items-center gap-1.5 px-2 text-[12px] text-text-tertiary">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          {t('tagFields.fill.reading')}
        </span>
      )
    }
    if (phase.kind !== 'idle' && !(phase.kind === 'disclosure' && phase.group === key)) return null
    if (!group.slots.some((slot) => !isFilledValue(slot.value))) return null
    return (
      <button
        type="button"
        onClick={() => start(group)}
        className="flex h-6 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12px] text-foreground hover:bg-muted"
        data-testid="field-fill-action"
      >
        <Sparkles className="size-3.5" aria-hidden />
        {t('tagFields.fill.action')}
      </button>
    )
  }

  const renderSlot = (group: FieldGroup, slot: FieldSlot): React.ReactNode => {
    if (phase.kind !== 'review') return null
    const proposal = phase.proposals.find((p) => p.field === slot.field.name)
    if (proposal) {
      return (
        <FillGhostRow
          key={slot.field.name}
          field={slot.field}
          proposal={proposal}
          busy={phase.busy}
          onAccept={() => void accept([proposal])}
          onReject={() => reject(proposal)}
        />
      )
    }
    if (groupKey(group) === phase.group && !isFilledValue(slot.value)) {
      return <FillMissingRow key={slot.field.name} field={slot.field} />
    }
    return null
  }

  const renderGroupFooter = (group: FieldGroup): React.ReactNode => {
    if (phase.kind !== 'disclosure' || phase.group !== groupKey(group)) return null
    return (
      <FillDisclosure
        model={phase.model}
        local={phase.local}
        onAccept={() => void run(phase.group, phase.tag, true)}
        onDecline={() => setPhase({ kind: 'idle' })}
      />
    )
  }

  return { renderGroupAction, renderSlot, renderGroupFooter }
}
