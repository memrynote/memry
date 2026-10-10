import * as React from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { PresetOffer } from '@memry/contracts/tag-schema-api'
import { Button } from '@/components/ui/button'
import { Check, Hash, Plus } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useEditTagSchema, useTagSchemas } from '../use-tag-schemas'
import { PresetTagChip } from './preset-tag-chip'
import { AddPresetFieldsDialog } from './AddPresetFieldsDialog'

export function PresetOfferStrip(): React.JSX.Element | null {
  const { t } = useT('notes')
  const { data: snapshot } = useTagSchemas()
  const editSchema = useEditTagSchema()
  const [busy, setBusy] = useState<string | null>(null)
  const [mergeOffer, setMergeOffer] = useState<PresetOffer | null>(null)

  if (!snapshot || snapshot.presetStripDismissed) return null
  if (!snapshot.presets.some((p) => p.state !== 'added')) return null

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await action()
    } catch (error) {
      toast.error(extractErrorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const addPreset = (offer: PresetOffer): Promise<void> =>
    run(offer.key, async () => {
      const result = await editSchema({ kind: 'add-preset', preset: offer.key })
      toast.success(t('tagFields.hub.toast.added', { tag: result.tag ?? offer.name }))
    })

  return (
    <section
      aria-labelledby="preset-offer-title"
      className="mb-[22px] rounded-[12px] bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="preset-offer-title" className="text-sm font-semibold text-foreground">
            {t('tagFields.hub.strip.title')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('tagFields.hub.strip.subtitle')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void run('dismiss', async () => {
              await editSchema({ kind: 'dismiss-preset-offer' })
            })
          }
          className="shrink-0 text-xs text-muted-foreground"
        >
          {t('tagFields.hub.strip.notNow')}
        </Button>
      </div>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        {snapshot.presets.map((offer) => (
          <div
            key={offer.key}
            className="flex min-w-0 flex-col items-start gap-2 rounded-[10px] border border-border bg-background p-3.5"
          >
            <PresetTagChip tag={offer.existingTag?.key ?? offer.name} preset={offer} />
            <p className="text-[13px] text-foreground">
              {offer.fields.map((f) => f.name).join(', ')}
            </p>
            {offer.existingTag && offer.state !== 'added' ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Hash aria-hidden className="size-3" />
                {offer.existingTag.usage === 1
                  ? t('tagFields.hub.strip.alreadyOnOne')
                  : t('tagFields.hub.strip.alreadyOn', { count: offer.existingTag.usage })}
              </p>
            ) : null}
            <div className="mt-auto pt-2">
              {offer.state === 'added' ? (
                <Button variant="outline" size="sm" disabled>
                  <Check aria-hidden className="size-3.5" />
                  {t('tagFields.hub.strip.added')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    offer.state === 'add-fields' ? setMergeOffer(offer) : void addPreset(offer)
                  }
                >
                  <Plus aria-hidden className="size-3.5" />
                  {offer.state === 'add-fields'
                    ? t('tagFields.hub.strip.addFields')
                    : t('tagFields.hub.strip.add')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <AddPresetFieldsDialog
        key={mergeOffer?.key ?? 'none'}
        offer={mergeOffer}
        onClose={() => setMergeOffer(null)}
      />
    </section>
  )
}
