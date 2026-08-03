import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { ProjectPicker } from '@/components/tasks/project-picker'
import { useTasksOptional } from '@/contexts/tasks'
import { extractErrorMessage } from '@/lib/ipc-error'
import { X } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import type { Project } from '@/data/tasks-data'
import { onProjectUpdated, tasksService, type ProjectRef } from '@/services/tasks-service'

const log = createLogger('EventProjectField')

// `listForItem` is a plain `ipcRenderer.invoke` with no timeout of its own, so a
// wedged main process leaves it pending forever. A load that has not answered by
// then stops blocking picks: an inert picker with no spinner and no way back
// short of reopening the popover is worse than a pick computed from links this
// old. Never reached on a healthy round trip, which takes milliseconds.
const LOAD_GUARD_TIMEOUT_MS = 10_000

// Stable identities: `ProjectPicker` memoizes its list on the `projects`
// reference, and the popover form re-renders on every keystroke.
const NO_PROJECTS: Project[] = []
const NO_LINKS: ProjectRef[] = []

export interface EventProjectFieldProps {
  mode: 'create' | 'edit'
  /** Saved event id. Required in edit mode; null while drafting a new event. */
  eventId?: string | null
  /** Create mode only: the draft's selected project id. */
  value: string | null
  /** Create mode only: writes the selection back into the draft. */
  onChange: (projectId: string | null) => void
  disabled?: boolean
}

/**
 * Project assignment for a calendar event, backed by `project_links`.
 *
 * Create mode is fully controlled — the selection rides in the draft until the
 * event has an id. Edit mode owns its own state and writes link/unlink
 * immediately, matching the calendar chip's "Add to project" context menu.
 */
export function EventProjectField({
  mode,
  eventId,
  value,
  onChange,
  disabled
}: EventProjectFieldProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const projects = useTasksOptional()?.projects ?? NO_PROJECTS
  const isEdit = mode === 'edit'
  const currentEventId = eventId ?? null

  // Both the loaded links and the last pick are keyed by the event they belong
  // to. The popover is re-rendered rather than remounted when the form moves to
  // another event, so unkeyed state would let one event's links choose the
  // unlink target for another. Keying also drops a stale pick for free.
  //
  // The pick has to be remembered at all because `getProjectsForItem` has no
  // ORDER BY: a reload after a swap can hand back the new link in any position,
  // and without this an event that also carries a legacy second link would show
  // that older link in the picker and demote the just-picked one to a chip.
  const [linkState, setLinkState] = useState<{ eventId: string | null; links: ProjectRef[] }>({
    eventId: currentEventId,
    links: NO_LINKS
  })
  const [chosen, setChosen] = useState<{ eventId: string | null; projectId: string | null }>({
    eventId: currentEventId,
    projectId: null
  })
  const links = linkState.eventId === currentEventId ? linkState.links : NO_LINKS
  const chosenId = chosen.eventId === currentEventId ? chosen.projectId : null

  // Both gate writes. `pendingLoads` is a counter, not a flag: the mount load,
  // the `projectUpdated` reload and the trailing reload can overlap, and a
  // boolean would report idle as soon as the *first* of them settled — long
  // enough for a click to compute its unlink target from links a later response
  // is about to replace. `loadToken` drops a response a newer load superseded.
  // Refs (not state) so the guard is visible synchronously to a call in the same
  // tick, before React re-renders.
  const pendingLoadsRef = useRef(0)
  const loadTokenRef = useRef(0)
  const isWritingRef = useRef(false)
  const isBusy = (): boolean => pendingLoadsRef.current > 0 || isWritingRef.current

  const load = useCallback(async (): Promise<void> => {
    if (!isEdit || !eventId) return
    const token = ++loadTokenRef.current
    pendingLoadsRef.current += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      pendingLoadsRef.current -= 1
    }
    const guardTimer = setTimeout(release, LOAD_GUARD_TIMEOUT_MS)
    try {
      const result = await tasksService.listForItem('calendar_event', eventId)
      // `listForItem` runs through the main-side `withDb` wrapper: on a DB
      // error it resolves `{ success: false, error }` instead of rejecting.
      if (loadTokenRef.current !== token) return
      setLinkState({ eventId, links: Array.isArray(result) ? result : NO_LINKS })
    } catch (error) {
      log.error('Failed to load event projects', extractErrorMessage(error))
      if (loadTokenRef.current === token) setLinkState({ eventId, links: NO_LINKS })
    } finally {
      clearTimeout(guardTimer)
      release()
    }
  }, [isEdit, eventId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // Nothing to reload for an unsaved event, and the canvas mounts one form
    // per event card — subscribing there would buy a listener per idle card
    // whose callback can only ever no-op.
    if (!isEdit || !eventId) return
    return onProjectUpdated(() => {
      // `linkItemToProject` / `unlinkItemFromProject` publish `projectUpdated`
      // *before* they resolve, so reloading on our own writes would fetch the
      // half-written state between the two calls of a swap — a visible "No
      // project" flash — and cost two extra round-trips. `runLinkWrite`
      // reloads once the whole write is done.
      if (isWritingRef.current) return
      void load()
    })
  }, [isEdit, eventId, load])

  // Shared by `handleSelect` and `handleRemoveExtra`: both are writes on the
  // same `project_links` rows. The reload is unconditional so the UI reflects
  // the actual DB state whether the write succeeded or failed, and it starts in
  // the same tick the write flag drops — `load` bumps `pendingLoads` before its
  // first await — so the guard never opens in between.
  const runLinkWrite = async (write: () => Promise<void>): Promise<void> => {
    isWritingRef.current = true
    try {
      await write()
    } catch (error) {
      log.error('Failed to write event project link', {
        eventId,
        error: extractErrorMessage(error)
      })
      toast.error(extractErrorMessage(error, t('form.project-update-failed')))
    } finally {
      isWritingRef.current = false
    }
    await load()
  }

  // `ProjectPicker` filters archived projects out of its list and resolves its
  // trigger only against that filtered list, so a link to an archived project
  // cannot be represented there. Anything it cannot show falls through to the
  // chips below, where it stays visible and removable — and is never the
  // implicit unlink target of the next pick.
  const isPickable = (projectId: string): boolean =>
    projects.some((project) => project.id === projectId && !project.isArchived)

  // The last pick when it survived the reload, else the first link the picker
  // can actually render. Falling through to `links[0]` instead would let a
  // single unpickable link hide a perfectly pickable sibling: the row would
  // read "No project" while a live link exists, and the next pick would add a
  // third link rather than replace the second.
  const primaryLink =
    links.find((link) => link.id === chosenId) ?? links.find((link) => isPickable(link.id))
  const primaryId = primaryLink && isPickable(primaryLink.id) ? primaryLink.id : null
  const selectedId = isEdit ? primaryId : value
  // Single-select UI over a many-to-many table: every link the picker is not
  // showing keeps its own removable chip. Nothing is dropped that the user did
  // not remove.
  const extraLinks = isEdit ? links.filter((link) => link.id !== primaryId) : []

  const handleSelect = async (nextId: string | null): Promise<void> => {
    // External `disabled` gates both modes; the in-flight guard only applies
    // where there is a write to guard.
    if (disabled) return
    if (!isEdit || !eventId) {
      onChange(nextId)
      return
    }
    if (isBusy()) return

    // Only the link the picker is actually showing can be replaced by a pick.
    const previousId = primaryId
    if (previousId === nextId) return

    setChosen({ eventId, projectId: nextId })
    await runLinkWrite(async () => {
      // Link before unlink. These are two independent IPC calls with no
      // transaction, so one of them can fail after the other landed; ending up
      // with one link too many leaves a removable chip on screen, while ending
      // up with none silently destroys an assignment the user asked to
      // *change*. `project_links` is unique per (project, item type, item), so
      // holding both links for the width of the swap is legal.
      if (nextId) {
        const added = await tasksService.linkProjectItem({
          projectId: nextId,
          itemType: 'calendar_event',
          itemId: eventId
        })
        if (!added.success) throw new Error(added.error)
      }
      if (previousId) {
        const removed = await tasksService.unlinkProjectItem({
          projectId: previousId,
          itemType: 'calendar_event',
          itemId: eventId
        })
        if (!removed.success) throw new Error(removed.error)
      }
    })
  }

  const handleRemoveExtra = async (projectId: string): Promise<void> => {
    if (!eventId) return
    // Same guard as `handleSelect`: a remove is a write on the same
    // `project_links` rows and must not run while another write or load is
    // in flight.
    if (disabled || isBusy()) return

    await runLinkWrite(async () => {
      const removed = await tasksService.unlinkProjectItem({
        projectId,
        itemType: 'calendar_event',
        itemId: eventId
      })
      if (!removed.success) throw new Error(removed.error)
    })
  }

  // Edit mode before the event is saved (canvas cards mount the form without an
  // id): nothing to link to, so render nothing rather than a dead control.
  if (isEdit && !eventId) return null

  return (
    // A plain <div>, not a <label>: a label forwards clicks on its
    // non-interactive descendants to its first labelable control, so wrapping
    // the chips alongside the picker would pop the dropdown open whenever the
    // user clicked a chip's name.
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{t('form.project')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ProjectPicker
          value={selectedId}
          onChange={(next) => void handleSelect(next)}
          projects={projects}
          includeAllOption
          allOptionLabel={t('form.no-project')}
          searchable
          allowCreate={false}
          disabled={disabled}
          className="min-w-[160px]"
        />
        {extraLinks.map((project) => (
          <span
            key={project.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
              aria-hidden="true"
            />
            <span className="max-w-32 truncate">{project.name}</span>
            <button
              type="button"
              aria-label={t('form.remove-from-project', { project: project.name })}
              onClick={() => void handleRemoveExtra(project.id)}
              disabled={disabled}
              className="text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

export default EventProjectField
