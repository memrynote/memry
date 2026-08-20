import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Lock, ChevronDown, ChevronRight } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useVault } from '@/hooks/use-vault'
import { useWeekStartsOn } from '@/hooks/use-calendar-preferences'
import { orderedWeekdays, weekdayLabel } from '@/lib/journal-template-resolution'
import { getI18n } from 'react-i18next'
import { formatJournalFilename } from '@memry/storage-vault/journal-format'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

// Radix Select has no empty-string value, so "fall back to the default" needs a
// sentinel. It is mapped to a stored `null` at the write boundary.
const INHERIT_VALUE = '__inherit__'

export function JournalSettings() {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const { templates, isLoading: isLoadingTemplates } = useTemplates()
  const {
    settings,
    updateSettings,
    setDefaultTemplate,
    setWeekdayTemplate,
    isLoading: isLoadingSettings
  } = useJournalSettings()
  const { config, updateConfig } = useVault()
  const weekStartsOn = useWeekStartsOn()
  const locale = getI18n().language || 'en-US'

  // Purely presentational: there is no "per-day mode" flag to persist or sync.
  // A day either has a template or it does not, so collapsing the section can
  // never silently disable one. Null means "not touched yet", which defers to
  // whether any day is configured — a configured setting must never hide behind
  // a collapsed row.
  const [perDayOverride, setPerDayOverride] = useState<boolean | null>(null)

  const [journalFolder, setJournalFolder] = useState('')
  const [journalDateFormat, setJournalDateFormat] = useState('')

  // Sync editable copies whenever the persisted vault config loads or changes.
  useEffect(() => {
    if (!config) return
    setJournalFolder(config.journalFolder)
    setJournalDateFormat(config.journalDateFormat)
  }, [config])

  const handleJournalFolderBlur = useCallback(() => {
    if (config && journalFolder !== config.journalFolder) {
      void updateConfig({ journalFolder })
    }
  }, [config, journalFolder, updateConfig])

  const handleJournalDateFormatBlur = useCallback(() => {
    if (config && journalDateFormat !== config.journalDateFormat) {
      void updateConfig({ journalDateFormat })
    }
  }, [config, journalDateFormat, updateConfig])

  const todayIso = new Date().toISOString().slice(0, 10)
  const previewFilename = `${formatJournalFilename(todayIso, journalDateFormat)}.md`
  const previewPath = journalFolder ? `${journalFolder}/${previewFilename}` : previewFilename

  const handleTemplateChange = useCallback(
    async (value: string) => {
      const templateId = value === 'none' ? null : value
      const success = await setDefaultTemplate(templateId)
      if (success) {
        toast.success(templateId ? t('journal.template.updated') : t('journal.template.cleared'))
      } else {
        toast.error(t('journal.template.error'))
      }
    },
    [setDefaultTemplate, t]
  )

  const handleShowStatsFooterChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showStatsFooter: checked })
      if (!success) toast.error(t('journal.updateError'))
    },
    [t, updateSettings]
  )

  const templateName = useCallback(
    (id: string | null | undefined): string | null =>
      id ? (templates.find((template) => template.id === id)?.name ?? null) : null,
    [templates]
  )

  const handleWeekdayTemplateChange = useCallback(
    async (weekday: number, value: string): Promise<void> => {
      const templateId = value === INHERIT_VALUE ? null : value
      const day = weekdayLabel(weekday, locale)
      const success = await setWeekdayTemplate(weekday, templateId)
      if (success) {
        toast.success(
          templateId ? t('journal.weekday.updated', { day }) : t('journal.weekday.cleared', { day })
        )
      } else {
        toast.error(t('journal.weekday.error', { day }))
      }
    },
    [locale, setWeekdayTemplate, t]
  )

  const defaultTemplateName = templateName(settings.defaultTemplate)

  // Absolute weekdays (0 = Sunday) reordered for display only. The stored key is
  // never positional, so flipping the first-day-of-week preference reorders
  // these rows without moving any template onto a different day.
  const orderedDays = useMemo(() => orderedWeekdays(weekStartsOn), [weekStartsOn])
  const configuredDayCount = useMemo(
    () => orderedDays.filter((day) => Boolean(settings.weekdayTemplates?.[String(day)])).length,
    [orderedDays, settings.weekdayTemplates]
  )
  const showPerDay = perDayOverride ?? configuredDayCount > 0

  if (isLoadingSettings) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('journal.header.title')} subtitle={t('journal.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('journal.header.title')} subtitle={t('journal.header.subtitle')} />

      <SettingsGroup label={t('journal.groups.defaultTemplate')}>
        <SettingRow
          label={t('journal.template.label')}
          description={t('journal.template.description')}
        >
          <Select
            value={settings.defaultTemplate ?? 'none'}
            onValueChange={(...args) => void handleTemplateChange(...args)}
            disabled={isLoadingTemplates || isLoadingSettings}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue placeholder={t('journal.template.placeholder')}>
                {isLoadingSettings
                  ? tCommon('state.loading')
                  : settings.defaultTemplate
                    ? (defaultTemplateName ?? t('journal.template.unknown'))
                    : t('journal.template.none')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('journal.template.noneAsk')}</SelectItem>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  <span className="flex items-center gap-2">
                    {template.icon && <span>{template.icon}</span>}
                    {template.name}
                    {template.isBuiltIn && <Lock className="w-3 h-3 text-muted-foreground ms-1" />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('journal.weekday.toggle')}
          description={t('journal.weekday.toggleDescription')}
          data-testid="journal-per-day-toggle"
        >
          <button
            type="button"
            aria-expanded={showPerDay}
            onClick={() => setPerDayOverride(!showPerDay)}
            className="flex items-center gap-1 text-xs/4 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPerDay ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            {t('journal.weekday.summary', { count: configuredDayCount })}
          </button>
        </SettingRow>

        {showPerDay &&
          orderedDays.map((weekday) => {
            const stored = settings.weekdayTemplates?.[String(weekday)] ?? null
            const storedName = templateName(stored)
            const label = weekdayLabel(weekday, locale)

            return (
              <SettingRow key={weekday} label={label} data-testid={`journal-weekday-${weekday}`}>
                <Select
                  value={stored ?? INHERIT_VALUE}
                  onValueChange={(value) => void handleWeekdayTemplateChange(weekday, value)}
                  disabled={isLoadingTemplates || isLoadingSettings}
                >
                  <SelectTrigger className={COMPACT_SELECT} aria-label={label}>
                    <SelectValue>
                      {/* Showing the resolved fallback rather than a bare
                          "Default" — five rows reading "Default" tell you
                          nothing about what actually opens that day. */}
                      {!stored ? (
                        <span className="text-muted-foreground">
                          {defaultTemplateName
                            ? t('journal.weekday.inheritWith', { name: defaultTemplateName })
                            : t('journal.weekday.inheritNone')}
                        </span>
                      ) : (
                        (storedName ?? (
                          <span className="text-destructive">{t('journal.weekday.missing')}</span>
                        ))
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>{t('journal.weekday.inherit')}</SelectItem>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        <span className="flex items-center gap-2">
                          {template.icon && <span>{template.icon}</span>}
                          {template.name}
                          {template.isBuiltIn && (
                            <Lock className="w-3 h-3 text-muted-foreground ms-1" />
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            )
          })}
      </SettingsGroup>

      <SettingsGroup label={t('journal.groups.location')}>
        <SettingRow label={t('journal.folder.label')} description={t('journal.folder.description')}>
          <Input
            value={journalFolder}
            onChange={(e) => setJournalFolder(e.target.value)}
            onBlur={handleJournalFolderBlur}
            placeholder={t('journal.folder.placeholder')}
            className="h-7 w-40 text-xs/4"
          />
        </SettingRow>

        <SettingRow
          label={t('journal.dateFormat.label')}
          description={t('journal.dateFormat.description')}
        >
          <Input
            value={journalDateFormat}
            onChange={(e) => setJournalDateFormat(e.target.value)}
            onBlur={handleJournalDateFormatBlur}
            placeholder={t('journal.dateFormat.placeholder')}
            className="h-7 w-40 text-xs/4"
          />
        </SettingRow>

        <SettingRow
          label={t('journal.preview.label')}
          description={t('journal.preview.description')}
        >
          <span className="font-mono text-xs/4 text-muted-foreground">{previewPath}</span>
        </SettingRow>
      </SettingsGroup>

      {/*
       * No "Sidebar Visibility" group. All three of its rows controlled nothing:
       * JournalDayPanel gates its schedule and task sections on feature flags and emptiness
       * only, never on `showSchedule` / `showTasks`, and nothing renders AIConnectionsPanel at
       * all. `journal.showSchedule`, `journal.showTasks`, and `journal.showAIConnections` stay
       * persisted and readable/writable through settings so existing installs keep their values
       * and re-exposing the rows later is a UI-only change.
       */}

      <SettingsGroup label={t('journal.groups.footer')}>
        <SettingRow
          label={t('journal.showStatsFooter.label')}
          description={t('journal.showStatsFooter.description')}
        >
          <Switch
            checked={settings.showStatsFooter}
            onCheckedChange={(...args) => void handleShowStatsFooterChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
