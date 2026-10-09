/**
 * First-run line (I1 · 1): which model reads the note, that only this note
 * is sent (or, for a local model, that it never leaves the device), and that
 * nothing is saved until accepted.
 */
import { useT } from '@memry/i18n/renderer'
import { Lock } from '@/lib/icons'
import { Button } from '@/components/ui/button'

interface FillDisclosureProps {
  model: string
  local: boolean
  /** Bulk fill reads many notes, one at a time. */
  many?: boolean
  onAccept: () => void
  onDecline: () => void
}

export function FillDisclosure({ model, local, many, onAccept, onDecline }: FillDisclosureProps) {
  const { t } = useT('notes')
  const key = local
    ? many
      ? 'tagFields.fill.disclosureLocalMany'
      : 'tagFields.fill.disclosureLocal'
    : many
      ? 'tagFields.fill.disclosureMany'
      : 'tagFields.fill.disclosure'
  return (
    <div
      className="mt-2 flex gap-2.5 rounded-lg bg-surface px-3.5 py-3"
      data-testid="field-fill-disclosure"
    >
      <Lock className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
      <div className="flex flex-col gap-2.5">
        <p className="text-[12.5px] leading-[1.45] text-text-secondary">{t(key, { model })}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onAccept}>
            {t('tagFields.fill.suggest')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDecline}>
            {t('tagFields.fill.notNow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
