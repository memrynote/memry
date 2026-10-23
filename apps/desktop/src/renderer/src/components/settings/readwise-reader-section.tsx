/**
 * The two Readwise Reader switches (#1420, Paper "#1414 Connected settings / B
 * (grouped)"). Both are off by default: a Reader library can hold thousands of
 * saved documents, and the article text is written once, at creation.
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

interface ReadwiseReaderSectionProps {
  options: ReadwiseOptions
  disabled: boolean
  onChange: (input: ReadwiseSetOptionsInput) => void
}

export function ReadwiseReaderSection({ options, disabled, onChange }: ReadwiseReaderSectionProps) {
  const { t } = useT('settings')
  return (
    <section className="flex flex-col">
      <h4 className={SETTINGS_GROUP_LABEL}>{t('import.dialog.readwise.groups.reader')}</h4>
      <div className={SETTINGS_CARD}>
        <SettingRow
          label={t('import.dialog.readwise.reader.documents.label')}
          description={t('import.dialog.readwise.reader.documents.description')}
        >
          <Switch
            checked={options.readerDocuments}
            onCheckedChange={(enabled) => {
              onChange({ readerDocuments: enabled })
            }}
            aria-label={t('import.dialog.readwise.reader.documents.label')}
            className={ACCENT_SWITCH}
            disabled={disabled}
          />
        </SettingRow>
        <SettingRow
          label={t('import.dialog.readwise.reader.fullText.label')}
          description={t('import.dialog.readwise.reader.fullText.description')}
        >
          <Switch
            checked={options.readerFullText}
            onCheckedChange={(enabled) => {
              onChange({ readerFullText: enabled })
            }}
            aria-label={t('import.dialog.readwise.reader.fullText.label')}
            className={ACCENT_SWITCH}
            disabled={disabled}
          />
        </SettingRow>
      </div>
    </section>
  )
}
