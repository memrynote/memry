/**
 * Template Draft
 *
 * A new template is an in-memory draft until the user clicks Create; from then
 * on every edit auto-saves silently, the way a note does. Nothing is written
 * while in draft, so a half-typed template never litters the template list.
 *
 * Only the active tab is mounted, so switching tabs unmounts the editor. A
 * saved template flushes its pending edits on unmount instead of dropping the
 * debounce, and keeps them in `unsavedEdits` until the write lands so a tab
 * reopened meanwhile (or after a failed write) comes back with them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useTemplates } from '@/hooks/use-templates'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { toTemplateProperties, type EditableProperty } from '@/lib/template-properties'
import { useT } from '@memry/i18n/renderer'
import type { Template } from '@/services/templates-service'

const log = createLogger('Hook:TemplateDraft')

const DEFAULT_AUTO_SAVE_DELAY_MS = 800

// Edits of an unmounted editor that have not been persisted yet, keyed by
// template id. Session memory only: it bridges a tab switch or a failed
// unmount flush, not an app restart.
const unsavedEdits = new Map<string, TemplateDraftFields>()

export interface TemplateDraftFields {
  name: string
  icon: string | null
  tags: string[]
  properties: EditableProperty[]
  content: string
}

export type TemplateSaveState = 'draft' | 'saved' | 'dirty' | 'saving'

export interface UseTemplateDraftOptions {
  templateId?: string
  initial: TemplateDraftFields
  autoSaveDelayMs?: number
  /** Receives the freshly created template so the caller can seed its cache. */
  onCreated?: (template: Template) => void
  /**
   * Receives the template after every successful update, including the flush
   * that runs after unmount, so the caller can keep its cache current.
   */
  onSaved?: (template: Template) => void
}

export interface UseTemplateDraftResult {
  fields: TemplateDraftFields
  /**
   * The fields the editor mounted with: `initial`, or edits recovered from an
   * earlier mount that never reached disk. Stable for the hook's lifetime.
   */
  mountedFields: TemplateDraftFields
  setFields: (update: Partial<TemplateDraftFields>) => void
  state: TemplateSaveState
  templateId: string | undefined
  isDirty: boolean
  canSave: boolean
  save: () => Promise<boolean>
  /**
   * The user chose to throw the pending edits away (template deleted, close
   * prompt answered Don't Save). Skips the unmount flush until the next edit.
   */
  discard: () => void
}

function serialize(fields: TemplateDraftFields): string {
  return JSON.stringify({
    name: fields.name.trim(),
    icon: fields.icon,
    tags: fields.tags,
    properties: toTemplateProperties(fields.properties),
    content: fields.content
  })
}

export function useTemplateDraft({
  templateId: initialTemplateId,
  initial,
  autoSaveDelayMs = DEFAULT_AUTO_SAVE_DELAY_MS,
  onCreated,
  onSaved
}: UseTemplateDraftOptions): UseTemplateDraftResult {
  const { t } = useT('notes')
  const { createTemplate, updateTemplate } = useTemplates({ autoLoad: false })

  // Read here, removed from the stash in the mount effect below (initializers
  // must stay pure: StrictMode runs them twice).
  const [mountedFields] = useState<TemplateDraftFields>(
    () => (initialTemplateId !== undefined && unsavedEdits.get(initialTemplateId)) || initial
  )
  const [fields, setFieldsState] = useState<TemplateDraftFields>(mountedFields)
  const [templateId, setTemplateId] = useState<string | undefined>(initialTemplateId)
  const [isSaving, setIsSaving] = useState(false)

  // The payload as last persisted (or as loaded). Dirtiness and the no-op
  // skip are both measured against this, so a round-trip back to the original
  // value correctly reads as clean.
  const persistedRef = useRef<string>(serialize(initial))
  const current = useMemo(() => serialize(fields), [fields])
  const isDirty = current !== persistedRef.current

  // `save` reads these instead of closing over the values, so it stays stable
  // for the debounce timer. `fieldsRef` is written by `setFields` itself rather
  // than synced after commit: the editor flushes its last keystrokes after this
  // component has unmounted, and those must still reach the unmount flush.
  const fieldsRef = useRef(mountedFields)
  const templateIdRef = useRef(templateId)
  useEffect(() => {
    templateIdRef.current = templateId
  })

  const mountedRef = useRef(false)
  const discardedRef = useRef(false)

  const state: TemplateSaveState = isSaving
    ? 'saving'
    : templateId === undefined
      ? 'draft'
      : isDirty
        ? 'dirty'
        : 'saved'

  const canSave = fields.name.trim().length > 0

  const persist = useCallback(async (): Promise<boolean> => {
    const snapshot = fieldsRef.current
    const name = snapshot.name.trim()
    if (name.length === 0) return false

    const payload = serialize(snapshot)
    if (payload === persistedRef.current) return true

    setIsSaving(true)
    try {
      const id = templateIdRef.current
      const properties = toTemplateProperties(snapshot.properties)

      if (id === undefined) {
        const created = await createTemplate({
          name,
          icon: snapshot.icon,
          tags: snapshot.tags,
          properties,
          content: snapshot.content
        })
        if (!created) {
          toast.error(t('templateEditor.toast.createFailed'))
          return false
        }
        persistedRef.current = payload
        setTemplateId(created.id)
        onCreated?.(created)
        return true
      }

      const updated = await updateTemplate({
        id,
        name,
        icon: snapshot.icon,
        tags: snapshot.tags,
        properties,
        content: snapshot.content
      })
      if (!updated) {
        toast.error(t('templateEditor.toast.saveFailed'))
        return false
      }
      persistedRef.current = payload
      // Only drop the stash if nothing newer replaced it while this was in
      // flight.
      if (unsavedEdits.get(id) === snapshot) unsavedEdits.delete(id)
      onSaved?.(updated)
      return true
    } catch (err) {
      log.error('Failed to save template:', err)
      toast.error(extractErrorMessage(err, t('templateEditor.toast.saveFailed')))
      return false
    } finally {
      setIsSaving(false)
    }
  }, [createTemplate, updateTemplate, onCreated, onSaved, t])

  // Writes run one at a time. The unmount flush can land while a debounced
  // save is still in flight; queued behind it, it re-reads the latest fields
  // and the no-op check instead of racing an older payload to disk.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const save = useCallback((): Promise<boolean> => {
    const run = queueRef.current.then(persist)
    queueRef.current = run.catch(() => undefined)
    return run
  }, [persist])

  // Held in a ref so the debounce below is not torn down and restarted every
  // time `save` is rebuilt. Synced after commit to keep render pure.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  // Called once the editor is gone. The pending edits are stashed first so a
  // remount before the write lands, or after it fails, restores them; the
  // failure itself is surfaced by the save toast.
  const flushUnmounted = useCallback(() => {
    const id = templateIdRef.current
    if (id === undefined || discardedRef.current) return
    const snapshot = fieldsRef.current
    if (serialize(snapshot) === persistedRef.current) return
    unsavedEdits.set(id, snapshot)
    void saveRef.current()
  }, [])

  const setFields = useCallback(
    (update: Partial<TemplateDraftFields>) => {
      fieldsRef.current = { ...fieldsRef.current, ...update }
      setFieldsState(fieldsRef.current)
      if (mountedRef.current) {
        discardedRef.current = false
        return
      }
      // A late edit from the editor's own teardown flush.
      flushUnmounted()
    },
    [flushUnmounted]
  )

  const discard = useCallback(() => {
    discardedRef.current = true
    const id = templateIdRef.current
    if (id !== undefined) unsavedEdits.delete(id)
  }, [])

  // Flush rather than drop pending edits when the editor unmounts. Deferred a
  // microtask so StrictMode's simulated unmount/remount cancels it.
  useEffect(() => {
    mountedRef.current = true
    // This mount now owns any recovered edits, and re-stashes them itself if
    // it unmounts before they are written.
    const recoveredId = templateIdRef.current
    if (recoveredId !== undefined) unsavedEdits.delete(recoveredId)
    return () => {
      mountedRef.current = false
      queueMicrotask(() => {
        if (!mountedRef.current) flushUnmounted()
      })
    }
  }, [flushUnmounted])

  // Auto-save only once the template exists. A draft is committed by the
  // Create button, never by a timer.
  useEffect(() => {
    if (templateId === undefined) return
    if (!isDirty) return

    const timer = setTimeout(() => {
      void saveRef.current()
    }, autoSaveDelayMs)

    return () => clearTimeout(timer)
  }, [templateId, isDirty, current, autoSaveDelayMs])

  return {
    fields,
    mountedFields,
    setFields,
    state,
    templateId,
    isDirty,
    canSave,
    save,
    discard
  }
}
