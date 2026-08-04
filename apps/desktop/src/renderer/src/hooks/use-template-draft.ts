/**
 * Template Draft
 *
 * A new template is an in-memory draft until the user clicks Create; from then
 * on every edit auto-saves silently, the way a note does. Nothing is written
 * while in draft, so a half-typed template never litters the template list.
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
}

export interface UseTemplateDraftResult {
  fields: TemplateDraftFields
  setFields: (update: Partial<TemplateDraftFields>) => void
  state: TemplateSaveState
  templateId: string | undefined
  isDirty: boolean
  canSave: boolean
  save: () => Promise<boolean>
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
  onCreated
}: UseTemplateDraftOptions): UseTemplateDraftResult {
  const { t } = useT('notes')
  const { createTemplate, updateTemplate } = useTemplates({ autoLoad: false })

  const [fields, setFieldsState] = useState<TemplateDraftFields>(initial)
  const [templateId, setTemplateId] = useState<string | undefined>(initialTemplateId)
  const [isSaving, setIsSaving] = useState(false)

  // The payload as last persisted (or as loaded). Dirtiness and the no-op
  // skip are both measured against this, so a round-trip back to the original
  // value correctly reads as clean.
  const persistedRef = useRef<string>(serialize(initial))
  const current = useMemo(() => serialize(fields), [fields])
  const isDirty = current !== persistedRef.current

  // `save` reads these instead of closing over the values, so it stays stable
  // for the debounce timer. Synced in an effect, not during render, because
  // render has to stay pure — and every reader runs after commit anyway.
  const fieldsRef = useRef(fields)
  const templateIdRef = useRef(templateId)
  useEffect(() => {
    fieldsRef.current = fields
    templateIdRef.current = templateId
  })

  const state: TemplateSaveState = isSaving
    ? 'saving'
    : templateId === undefined
      ? 'draft'
      : isDirty
        ? 'dirty'
        : 'saved'

  const canSave = fields.name.trim().length > 0

  const setFields = useCallback((update: Partial<TemplateDraftFields>) => {
    setFieldsState((prev) => ({ ...prev, ...update }))
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
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
      return true
    } catch (err) {
      log.error('Failed to save template:', err)
      toast.error(extractErrorMessage(err, t('templateEditor.toast.saveFailed')))
      return false
    } finally {
      setIsSaving(false)
    }
  }, [createTemplate, updateTemplate, onCreated, t])

  // Held in a ref so the debounce below is not torn down and restarted every
  // time `save` is rebuilt. Synced after commit to keep render pure.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

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

  return { fields, setFields, state, templateId, isDirty, canSave, save }
}
