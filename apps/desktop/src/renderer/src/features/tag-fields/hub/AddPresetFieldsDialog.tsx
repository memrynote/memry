/**
 * A2: a ready-made tag whose name already exists adds its fields to that tag
 * instead of creating a second one. "Use another name" puts the fields on a
 * new tag and leaves the existing one plain.
 */
import * as React from 'react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { PresetOffer } from '@memry/contracts/tag-schema-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  ArrowUpRight,
  Calendar,
  CheckSquare,
  Hash,
  LayoutTemplate,
  Link,
  Link2,
  List,
  Plus,
  Tags,
  Type,
  type AppIcon
} from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { tagsService } from '@/services/tags-service'
import { useEditTagSchema } from '../use-tag-schemas'
import { PresetTagChip } from './preset-tag-chip'

const FIELD_TYPE_ICONS: Record<string, AppIcon> = {
  text: Type,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  select: List,
  multiselect: Tags,
  status: List,
  url: Link,
  relation: Link2
}

export function AddPresetFieldsDialog({
  offer,
  onClose
}: {
  offer: PresetOffer | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const editSchema = useEditTagSchema()
  const [otherName, setOtherName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const tag = offer?.existingTag?.key ?? offer?.name ?? ''

  const impact = useQuery({
    queryKey: ['tags', 'preview-impact', 'become-objects', tag],
    queryFn: () => tagsService.previewImpact({ kind: 'become-objects', tag }),
    enabled: offer !== null
  })
  const count =
    impact.data?.kind === 'become-objects' ? impact.data.notes : (offer?.existingTag?.usage ?? 0)

  const presetName = offer ? t(`tagFields.presets.${offer.key}.name`) : ''
  const trimmedOther = otherName?.trim() ?? ''

  const submit = async (): Promise<void> => {
    if (!offer) return
    setBusy(true)
    try {
      const result = await editSchema(
        otherName === null
          ? { kind: 'add-preset', preset: offer.key }
          : { kind: 'add-preset', preset: offer.key, tag: trimmedOther }
      )
      const written = result.tag ?? (otherName === null ? tag : trimmedOther)
      toast.success(t('tagFields.hub.toast.addedFields', { preset: presetName, tag: written }))
      onClose()
    } catch (error) {
      toast.error(extractErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={offer !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        {offer ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('tagFields.hub.dialog.title', { preset: presetName, tag })}
              </DialogTitle>
              <DialogDescription>
                {count === 1
                  ? t('tagFields.hub.dialog.bodyOne', { tag })
                  : t('tagFields.hub.dialog.body', { tag, count })}
              </DialogDescription>
            </DialogHeader>
            <ul className="rounded-[10px] border border-border px-3 py-1.5">
              {offer.fields.map((field) => {
                const Icon = FIELD_TYPE_ICONS[field.type] ?? Type
                return (
                  <li key={field.name} className="flex items-center gap-2 py-1.5 text-[13px]">
                    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="w-[100px] shrink-0 truncate text-foreground">
                      {field.name}
                    </span>
                    {field.relationTarget ? (
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <ArrowUpRight aria-hidden className="size-3 shrink-0" />
                        <PresetTagChip tag={field.relationTarget} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t(`properties.types.${field.type}`)}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="flex flex-col gap-2 text-[13px] text-muted-foreground">
              {offer.templateSections.length > 0 ? (
                <p className="flex items-center gap-2">
                  <LayoutTemplate aria-hidden className="size-3.5 shrink-0" />
                  {t('tagFields.hub.dialog.template', {
                    sections: offer.templateSections.join(', ')
                  })}
                </p>
              ) : null}
              {offer.alsoAdds.map((target) => {
                const field = offer.fields.find((f) => f.relationTarget === target)?.name ?? ''
                return (
                  <p key={target} className="flex flex-wrap items-center gap-1.5">
                    <Plus aria-hidden className="size-3.5 shrink-0" />
                    {t('tagFields.hub.dialog.alsoAddsPrefix', { field })}
                    <PresetTagChip tag={target} />
                    {t('tagFields.hub.dialog.alsoAddsSuffix', { field })}
                  </p>
                )
              })}
            </div>
            {otherName !== null ? (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {t('tagFields.hub.dialog.nameLabel')}
                <Input
                  autoFocus
                  value={otherName}
                  maxLength={50}
                  placeholder={t('tagFields.hub.dialog.namePlaceholder')}
                  onChange={(e) => setOtherName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && trimmedOther) void submit()
                  }}
                />
              </label>
            ) : null}
            <DialogFooter className="items-center sm:justify-between">
              {otherName === null ? (
                <Button variant="ghost" onClick={() => setOtherName('')} disabled={busy}>
                  {t('tagFields.hub.dialog.useAnotherName')}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose} disabled={busy}>
                  {t('tagFields.hub.dialog.cancel')}
                </Button>
                <Button
                  onClick={() => void submit()}
                  disabled={busy || (otherName !== null && !trimmedOther)}
                >
                  {t('tagFields.hub.dialog.addFields')}
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
