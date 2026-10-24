import { useT } from '@memry/i18n/renderer'
import { Switch } from '@/components/ui/switch'
import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  SettingsHeader,
  SettingsGroup,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { FEATURE_KEYS, type FeatureKey } from '@memry/contracts/feature-flags'

/** Modules that have their own settings sub-page. */
export const CONFIGURABLE_MODULES = ['journal', 'tasks', 'inbox', 'calendar'] as const
export type ConfigurableModule = (typeof CONFIGURABLE_MODULES)[number]

function isConfigurable(key: FeatureKey): key is ConfigurableModule {
  return (CONFIGURABLE_MODULES as readonly string[]).includes(key)
}

interface FeaturesSectionProps {
  /** Opens a module's settings sub-page. Without it, rows are toggle-only. */
  onConfigure?: (module: ConfigurableModule) => void
}

export function FeaturesSection({ onConfigure }: FeaturesSectionProps = {}) {
  const { t } = useT('settings')
  const { flags, setFlag } = useFeatureFlags()

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('features.header.title')} subtitle={t('features.header.subtitle')} />
      <SettingsGroup>
        {FEATURE_KEYS.map((key: FeatureKey) => {
          const label = t(`features.items.${key}.label`)
          const enabled = flags[key]
          const configure = onConfigure && isConfigurable(key) ? () => onConfigure(key) : undefined
          const canConfigure = Boolean(configure) && enabled

          return (
            <div key={key} className="flex items-center gap-4 min-h-14 py-2.5">
              <button
                type="button"
                onClick={configure}
                disabled={!canConfigure}
                aria-label={
                  canConfigure ? t('page.modules.configure', { module: label }) : undefined
                }
                className={cn(
                  'flex flex-1 min-w-0 flex-col gap-0.5 text-start',
                  canConfigure ? 'cursor-pointer' : 'cursor-default'
                )}
              >
                <span
                  className={cn(
                    'text-[13px]/4',
                    enabled ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {label}
                </span>
                <span className="text-xs/4 text-muted-foreground">
                  {t(`features.items.${key}.description`)}
                </span>
              </button>
              <Switch
                aria-label={label}
                checked={enabled}
                onCheckedChange={(value) => void setFlag(key, value)}
                className={ACCENT_SWITCH}
              />
              {onConfigure && (
                <span className="flex w-6 shrink-0 justify-end">
                  {configure && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      onClick={configure}
                      disabled={!canConfigure}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
                    </button>
                  )}
                </span>
              )}
            </div>
          )
        })}
      </SettingsGroup>
    </div>
  )
}

export default FeaturesSection
