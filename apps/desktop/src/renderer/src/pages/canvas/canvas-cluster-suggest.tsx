/**
 * "Suggest groups" on a canvas: group the note cards on the board (or the
 * selected ones) by local embedding similarity, let the user review each
 * proposed group, and turn the accepted ones into named frames.
 *
 * Nothing touches the scene until the user presses Create. The grouping comes
 * from vectors already stored on this device; no note text leaves it. The
 * whole write is one scene update, so one undo takes it back.
 *
 * Lives in the Excalidraw chunk (it is mounted by CanvasEditor), so the
 * static Excalidraw import here costs nothing extra.
 */

import React, { useCallback, useState } from 'react'
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { toast } from 'sonner'
import { MAX_CLUSTER_NOTES, type NoteClusterGroup } from '@memry/contracts/notes-api'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { LayoutGrid } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { notesService } from '@/services/notes-service'
import { getCardRefs, type CardElement } from './canvas-cards'
import { planClusterLayout } from './canvas-cluster-layout'
import { applyDrawPlan, applyElementEdits, planDraw } from './canvas-draw-plan'
import type { SceneEditElement } from './canvas-scene-edit'
import { drawOptions } from './canvas-write'

const log = createLogger('CanvasClusterSuggest')

/** Fewer notes than this cannot form two groups worth proposing. */
const MIN_NOTES = 3

interface ProposedGroup {
  key: string
  name: string
  accepted: boolean
  noteIds: string[]
  titles: string[]
}

function toProposals(groups: NoteClusterGroup[], fallbackName: (n: number) => string) {
  return groups.map((group, index): ProposedGroup => ({
    key: group.noteIds.join('|'),
    name: group.suggestedName ?? fallbackName(index + 1),
    accepted: true,
    noteIds: group.noteIds,
    titles: group.titles
  }))
}

/** The note cards to group: the selected ones when two or more are selected, else the board. */
function noteCardsInScope(api: ExcalidrawImperativeAPI): {
  byNote: Map<string, string>
  scope: 'selection' | 'board'
} {
  const cards = getCardRefs(api.getSceneElements() as unknown as CardElement[]).filter(
    (card) => card.entityType === 'note'
  )
  const selected = api.getAppState().selectedElementIds
  const selectedCards = cards.filter((card) => selected[card.elementId])
  const scoped = selectedCards.length >= 2 ? selectedCards : cards
  // One card per note: a canvas holds one, but a pasted duplicate must not
  // pull the same note into two frames.
  const byNote = new Map<string, string>()
  for (const card of scoped)
    if (!byNote.has(card.entityId)) byNote.set(card.entityId, card.elementId)
  return { byNote, scope: selectedCards.length >= 2 ? 'selection' : 'board' }
}

export function CanvasClusterSuggest({
  api,
  onSceneMutated
}: {
  api: ExcalidrawImperativeAPI
  onSceneMutated: () => void
}): React.JSX.Element {
  const { t } = useT('common')
  const [loading, setLoading] = useState(false)
  const [proposals, setProposals] = useState<ProposedGroup[] | null>(null)
  const [creating, setCreating] = useState(false)

  const suggest = useCallback(async (): Promise<void> => {
    const { byNote, scope } = noteCardsInScope(api)
    if (byNote.size < MIN_NOTES) {
      toast.info(t('canvas.cluster.needMoreNotes', { count: MIN_NOTES }))
      return
    }
    if (byNote.size > MAX_CLUSTER_NOTES) {
      toast.info(t('canvas.cluster.tooMany', { count: MAX_CLUSTER_NOTES }))
      return
    }
    setLoading(true)
    try {
      const result = await notesService.cluster([...byNote.keys()])
      if (result.status === 'disabled') {
        toast.info(t('canvas.cluster.disabled'))
        return
      }
      if (result.groups.length === 0) {
        toast.info(t('canvas.cluster.noGroups'))
        return
      }
      setProposals(
        toProposals(result.groups, (n) => t('canvas.cluster.defaultName', { number: n }))
      )
      if (result.missing.length > 0) {
        toast.info(t('canvas.cluster.missing', { count: result.missing.length }))
      }
      log.debug('Cluster suggestions ready', { scope, groups: result.groups.length })
    } catch (err) {
      toast.error(extractErrorMessage(err, t('canvas.cluster.failed')))
    } finally {
      setLoading(false)
    }
  }, [api, t])

  const update = (key: string, patch: Partial<ProposedGroup>): void => {
    setProposals((current) =>
      current ? current.map((group) => (group.key === key ? { ...group, ...patch } : group)) : null
    )
  }

  const create = useCallback(async (): Promise<void> => {
    const accepted = (proposals ?? []).filter((group) => group.accepted)
    if (accepted.length === 0) return
    setCreating(true)
    try {
      // Read the scene NOW, not when the suggestions were made: the board may
      // have changed while the dialog was open, and a card deleted since then
      // must not be framed.
      const options = await drawOptions()
      const scene = api.getSceneElementsIncludingDeleted() as unknown as SceneEditElement[]
      const cardByNote = new Map<string, string>()
      for (const card of getCardRefs(scene.filter((el) => !el.isDeleted))) {
        if (card.entityType === 'note' && !cardByNote.has(card.entityId)) {
          cardByNote.set(card.entityId, card.elementId)
        }
      }

      const layout = planClusterLayout(
        scene,
        accepted.map((group) => ({
          name: group.name.trim() || t('canvas.cluster.untitledGroup'),
          elementIds: group.noteIds.flatMap((id) => {
            const elementId = cardByNote.get(id)
            return elementId ? [elementId] : []
          })
        }))
      )
      if (layout.frames.length === 0) {
        toast.info(t('canvas.cluster.cardsGone'))
        setProposals(null)
        return
      }

      const moved = applyElementEdits(scene, layout.moves, options).elements
      const plan = planDraw(moved, layout.frames, options)
      const created = convertToExcalidrawElements(
        plan.skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0],
        { regenerateIds: false }
      ) as unknown as SceneEditElement[]
      const next = applyDrawPlan(moved, created, plan)

      // One update, captured immediately: one undo step takes the moves and
      // the frames back together.
      api.updateScene({
        elements: next as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      onSceneMutated()
      const frames = api
        .getSceneElements()
        .filter((element) => created.some((frame) => frame.id === element.id))
      if (frames.length > 0) api.scrollToContent(frames, { fitToContent: true, animate: true })

      toast.success(t('canvas.cluster.created', { count: layout.frames.length }))
      setProposals(null)
    } catch (err) {
      log.error('Failed to create cluster frames', err)
      toast.error(extractErrorMessage(err, t('canvas.cluster.failed')))
    } finally {
      setCreating(false)
    }
  }, [api, onSceneMutated, proposals, t])

  const acceptedCount = proposals?.filter((group) => group.accepted).length ?? 0

  return (
    <>
      <button
        type="button"
        onClick={() => void suggest()}
        disabled={loading}
        data-testid="canvas-suggest-groups"
        title={t('canvas.cluster.buttonHint')}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-text-secondary shadow-sm transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      >
        <LayoutGrid className="size-3.5" aria-hidden="true" />
        {loading ? t('canvas.cluster.loading') : t('canvas.cluster.button')}
      </button>

      <Dialog
        open={proposals !== null}
        onOpenChange={(open) => {
          if (!open && !creating) setProposals(null)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('canvas.cluster.title')}</DialogTitle>
            <DialogDescription>{t('canvas.cluster.description')}</DialogDescription>
          </DialogHeader>

          <ul className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto pe-1">
            {(proposals ?? []).map((group) => (
              <li
                key={group.key}
                className="flex flex-col gap-1.5 rounded-md border border-border p-2.5"
                data-testid="canvas-cluster-group"
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={group.accepted}
                    onCheckedChange={(checked) => update(group.key, { accepted: checked === true })}
                    aria-label={t('canvas.cluster.acceptGroup', { name: group.name })}
                  />
                  <Input
                    value={group.name}
                    onChange={(event) => update(group.key, { name: event.target.value })}
                    disabled={!group.accepted}
                    aria-label={t('canvas.cluster.groupName')}
                    className="h-8 text-sm"
                  />
                  <span className="shrink-0 text-xs text-text-tertiary tabular-nums">
                    {t('canvas.cluster.noteCount', { count: group.noteIds.length })}
                  </span>
                </div>
                <p className="ps-6 text-xs text-text-tertiary line-clamp-2">
                  {group.titles.filter(Boolean).join(', ')}
                </p>
              </li>
            ))}
          </ul>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setProposals(null)} disabled={creating}>
              {t('canvas.cluster.discard')}
            </Button>
            <Button onClick={() => void create()} disabled={creating || acceptedCount === 0}>
              {t('canvas.cluster.create', { count: acceptedCount })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
