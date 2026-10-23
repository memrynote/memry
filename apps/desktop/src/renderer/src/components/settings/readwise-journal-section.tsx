/**
 * The journal switch of the connected panel (#3476, Paper "#3476 Journal switch
 * / panel (off, on)"). Off by default: it writes into the files the user
 * writes, one section per day with new highlights, and never backfills.
 */

import { useT } from '@memry/i18n/renderer'
import type { ReadwiseOptions, ReadwiseSetOptionsInput } from '@memry/contracts/import-channels'
import { Switch } from '@/components/ui/switch'
import {
  ACCENT_SWITCH,
  SETTINGS_CARD,
  SETTINGS_GROUP_LABEL,
  SettingRow
} from '@/components/settings/settings-primitives'

interface ReadwiseJournalSectionProps {
  options: ReadwiseOptions
  disabled: boolean
  onChange: (input: ReadwiseSetOptionsInput) => void
}

export function ReadwiseJournalSection({
  options,
  disabled,
  onChange
}: ReadwiseJournalSectionProps) {
  const { t } = useT('settings')
  return (
    <section className="flex flex-col">
      <h4 className={SETTINGS_GROUP_LABEL}>{t('import.dialog.readwise.groups.journal')}</h4>
      <div className={SETTINGS_CARD}>
        <SettingRow
          label={t('import.dialog.readwise.journal.highlights.label')}
          description={t('import.dialog.readwise.journal.highlights.description')}
        >
          <Switch
            checked={options.journalHighlights}
            onCheckedChange={(enabled) => {
              onChange({ journalHighlights: enabled })
            }}
            aria-label={t('import.dialog.readwise.journal.highlights.label')}
            className={ACCENT_SWITCH}
            disabled={disabled}
          />
        </SettingRow>
      </div>
    </section>
  )
}
