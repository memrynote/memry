/**
 * C3: a note that already had text never gets a template pushed into it.
 * Main offers it instead, and this quiet row adds it below the text or is
 * dismissed; either way the offer is gone for this note on this device.
 */
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { LayoutTemplate, X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { templatesService } from '@/services/templates-service'
import { insertTemplateBlocks } from '@/components/note/content-area/insert-template'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { templateOffers, usePendingTemplateOffers } from './template-offers'
import { useTagSchemas } from './use-tag-schemas'

const log = createLogger('TemplateOfferRow')

export interface TemplateOffersProps {
  noteId: string
  noteTitle: string
  notePath?: string
  /** Header tags, lowercase match; an offer for a tag no longer there is not shown. */
  headerTags: readonly string[]
  /** The live editor; null while it mounts. */
  getEditor: () => unknown
  disabled?: boolean
}

interface InsertableEditor {
  document: Array<{ id: string }>
}

function isInsertableEditor(value: unknown): value is InsertableEditor {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { document?: unknown }).document)
  )
}

export function TemplateOffers({
  noteId,
  noteTitle,
  notePath,
  headerTags,
  getEditor,
  disabled
}: TemplateOffersProps) {
  const { t } = useT('notes')
  const pending = usePendingTemplateOffers(noteId)
  const { data: snapshot } = useTagSchemas()
  const [busy, setBusy] = useState(false)

  const add = useCallback(
    async (tag: string, templateId: string) => {
      const editor = getEditor()
      const last = isInsertableEditor(editor) ? editor.document.at(-1) : undefined
      if (!editor || !last) return
      setBusy(true)
      try {
        const template = await templatesService.get(templateId)
        if (!template) throw new Error('Template not found')
        const result = await insertTemplateBlocks({
          editor,
          content: template.content,
          noteTitle,
          referenceBlockId: last.id,
          placement: 'after',
          notePath
        })
        if (!result.ok && result.reason === 'stale-block') throw new Error('The note changed')
        templateOffers.resolve(noteId, tag)
      } catch (err) {
        log.error('add tag template failed:', err)
        toast.error(extractErrorMessage(err, t('tagFields.offer.addFailed')))
      } finally {
        setBusy(false)
      }
    },
    [getEditor, noteId, noteTitle, notePath, t]
  )

  const header = new Set(headerTags.map((tag) => tag.toLowerCase()))
  const offers = pending.flatMap((key) => {
    const tag = snapshot?.tags[key]
    return tag?.template && header.has(key) ? [{ tag, templateId: tag.template.id }] : []
  })
  if (offers.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      {offers.map(({ tag, templateId }) => (
        <div
          key={tag.key}
          className="flex min-h-10 items-center gap-2.5 rounded-lg border border-dashed border-border ps-3 pe-2 text-[13px] text-text-secondary"
          data-testid="template-offer-row"
        >
          <LayoutTemplate className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {t('tagFields.offer.text', { tag: tag.name })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[12px]"
            disabled={disabled || busy}
            onClick={() => void add(tag.key, templateId)}
          >
            {t('tagFields.offer.add')}
          </Button>
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md text-text-tertiary hover:bg-muted hover:text-foreground"
            aria-label={t('tagFields.offer.dismiss')}
            onClick={() => templateOffers.resolve(noteId, tag.key)}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
