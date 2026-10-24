import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { STICKY_SETTINGS_DEFAULTS, type StickySettings } from '@memry/contracts/settings-schemas'
import { STICKY_KINDS } from '@memry/contracts/sticky-api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { createLogger } from '@/lib/logger'
import {
  COMPACT_SELECT,
  SEGMENTED,
  SEGMENT_ITEM,
  SettingsGroup,
  SettingRow
} from '@/components/settings/settings-primitives'

const log = createLogger('StickySettings')

/** Settings → General → Sticky: how the sticky opens. It follows the app theme. */
export function StickySettingsGroup(): React.JSX.Element {
  const { t } = useT('settings')
  const [settings, setSettings] = useState<StickySettings>(STICKY_SETTINGS_DEFAULTS)

  useEffect(() => {
    void window.api.settings
      .getStickySettings()
      .then(setSettings)
      .catch((err: unknown) => log.error('Failed to load sticky settings', err))
  }, [])

  const update = useCallback(
    async (updates: Partial<StickySettings>) => {
      try {
        const result = await window.api.settings.setStickySettings(updates)
        if (!result.success) throw new Error(result.error ?? 'Update failed')
        setSettings((prev) => ({ ...prev, ...updates }))
      } catch (err) {
        log.error('Failed to save sticky settings', err)
        toast.error(t('general.sticky.error'))
      }
    },
    [t]
  )

  return (
    <SettingsGroup label={t('general.groups.sticky')} description={t('general.sticky.description')}>
      <SettingRow label={t('general.sticky.defaultKind.label')}>
        <Select
          value={settings.defaultKind}
          onValueChange={(value) =>
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Radix onValueChange yields string; the rendered options are exactly this union
            void update({ defaultKind: value as StickySettings['defaultKind'] })
          }
        >
          <SelectTrigger
            className={COMPACT_SELECT}
            aria-label={t('general.sticky.defaultKind.label')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last">{t('general.sticky.defaultKind.last')}</SelectItem>
            {STICKY_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`general.sticky.defaultKind.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow label={t('general.sticky.tuckEdge.label')}>
        <ToggleGroup
          type="single"
          value={settings.tuckEdge}
          onValueChange={(value) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Radix onValueChange yields string; the rendered options are exactly this union
            if (value) void update({ tuckEdge: value as StickySettings['tuckEdge'] })
          }}
          aria-label={t('general.sticky.tuckEdge.label')}
          className={SEGMENTED}
        >
          {(['left', 'right'] as const).map((edge) => (
            <ToggleGroupItem key={edge} value={edge} className={SEGMENT_ITEM}>
              {t(`general.sticky.tuckEdge.${edge}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
    </SettingsGroup>
  )
}
