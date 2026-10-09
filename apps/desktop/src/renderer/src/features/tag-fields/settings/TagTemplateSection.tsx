import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import { ArrowUpRight, Plus } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTabs } from '@/contexts/tabs'
import { extractErrorMessage } from '@/lib/ipc-error'
import { templatesService } from '@/services/templates-service'
import { useEditTagSchema } from '../use-tag-schemas'
import { templatePreview } from './settings-logic'
import { tagDisplayName } from '../tag-display-name'

interface TagTemplateSectionProps {
  tagKey: string
  tag: ResolvedTag | null
  disabled: boolean
  label: React.ReactNode
}

/** B1 TEMPLATE: the referenced template's headings, its editor, and autofill. */
export function TagTemplateSection({
  tagKey,
  tag,
  disabled,
  label
}: TagTemplateSectionProps): React.JSX.Element {
  const { t } = useT('notes')
  const { openTab } = useTabs()
  const editSchema = useEditTagSchema()
  const [busy, setBusy] = useState(false)
  const reference = tag?.template ?? null
  const templateQuery = useQuery({
    queryKey: ['tags', 'settings', 'template', reference?.id],
    enabled: reference !== null,
    queryFn: () => templatesService.get(reference?.id ?? '')
  })
  const template = templateQuery.data ?? null
  const missing = reference === null || (templateQuery.isSuccess && template === null)
  const tagName = tag?.name ?? tagKey

  const openEditor = (id: string, title: string): void => {
    openTab({
      type: 'template-editor',
      title,
      icon: 'file-text',
      path: `/templates/${id}`,
      entityId: id,
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }

  const createTemplate = async (): Promise<void> => {
    setBusy(true)
    try {
      const name = tagDisplayName(tagName)
      const result = await templatesService.create({
        name,
        content: `## ${t('tagFields.settings.template.defaultHeading')}\n`
      })
      if (!result.success || !result.template) {
        throw new Error(result.error ?? t('tagFields.settings.errors.template'))
      }
      await editSchema({
        kind: 'set-template',
        tag: tagKey,
        template: { id: result.template.id, autofill: true }
      })
      openEditor(result.template.id, name)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.template')))
    } finally {
      setBusy(false)
    }
  }

  const setAutofill = async (autofill: boolean): Promise<void> => {
    if (!reference) return
    try {
      await editSchema({
        kind: 'set-template',
        tag: tagKey,
        template: { id: reference.id, autofill }
      })
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.template')))
    }
  }

  const sections = template ? templatePreview(template.content) : []
  const inheritedFrom = reference?.inheritedFrom ?? null

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        {label}
        {!missing && template && (
          <button
            type="button"
            onClick={() => openEditor(template.id, template.name)}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-foreground"
          >
            <ArrowUpRight className="size-3" />
            {t('tagFields.settings.template.edit')}
          </button>
        )}
      </div>

      {missing ? (
        <div className="flex flex-col items-start gap-2 rounded-lg bg-muted/60 p-4">
          <p className="text-xs text-text-secondary">{t('tagFields.settings.template.none')}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => void createTemplate()}
          >
            <Plus className="size-3.5" />
            {t('tagFields.settings.template.create')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/60 p-4">
          {inheritedFrom && (
            <span className="text-xs text-text-tertiary">
              {t('tagFields.settings.template.inherited', { tag: inheritedFrom })}
            </span>
          )}
          {!template ? (
            <Skeleton className="h-12 w-full" />
          ) : sections.length === 0 ? (
            <span className="text-xs text-text-tertiary">{template.name}</span>
          ) : (
            sections.map((section, index) => (
              <div key={index} className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{section.heading}</span>
                <span className="truncate text-xs text-text-tertiary">{section.hint ?? '-'}</span>
              </div>
            ))
          )}
        </div>
      )}

      {reference && !inheritedFrom && !missing && (
        <label className="flex items-center gap-2.5 text-sm">
          <Switch
            checked={reference.autofill}
            disabled={disabled}
            onCheckedChange={(checked) => void setAutofill(checked)}
          />
          {t('tagFields.settings.template.autofill', { tag: tagName })}
        </label>
      )}
    </section>
  )
}
