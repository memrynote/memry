import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, Copy, Pencil, Plus, RotateCcw, Trash2, X } from '@/lib/icons'
import type { CustomTheme, ThemeBase } from '@memry/contracts/themes-api'
import { THEME_HEX_REGEX } from '@memry/contracts/themes-api'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { SettingsGroup } from '@/components/settings/settings-primitives'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useCustomThemes } from '@/hooks/use-custom-themes'
import {
  THEME_VARIABLES,
  labelForThemeVariable,
  type ThemeVariableDef
} from '@/lib/theme-variables'
import { applyCustomThemeVariables } from '@/lib/theme-overrides'

const PERSIST_DEBOUNCE_MS = 500

const SECTION_ORDER = [
  'surfaces',
  'text',
  'sidebar',
  'accent',
  'dots',
  'cards',
  'states',
  'sidebarDetails',
  'graph',
  'tasks',
  'queue'
] as const

function baseForCurrentTheme(theme: string): ThemeBase {
  if (theme === 'dark' || theme === 'white' || theme === 'light') return theme
  // 'system' — resolve from the current media query.
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function computedVarValue(cssVar: string): string {
  if (typeof window === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
}

interface VariableRowProps {
  def: ThemeVariableDef
  override: string | undefined
  onChange: (cssVar: string, value: string | null) => void
}

function VariableRow({ def, override, onChange }: VariableRowProps) {
  const { t } = useT('settings')
  const [draft, setDraft] = useState('')
  const fallback = useMemo(
    () => computedVarValue(def.cssVar),
    // Re-read the base value whenever the override toggles off.
    [def.cssVar, override]
  )
  const shown = draft || override || fallback
  const pickerValue = THEME_HEX_REGEX.test(shown) ? shown : '#000000'

  const commitDraft = (value: string): void => {
    if (THEME_HEX_REGEX.test(value)) {
      onChange(def.cssVar, value)
      setDraft('')
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1.5 px-4">
      <span
        className={cn(
          'text-xs',
          override ? 'text-foreground font-medium' : 'text-muted-foreground'
        )}
      >
        {labelForThemeVariable(def)}
      </span>
      <div className="flex items-center shrink-0 gap-1.5">
        <Input
          value={draft || override || fallback}
          placeholder={fallback}
          maxLength={7}
          aria-label={labelForThemeVariable(def)}
          onChange={(e) => {
            setDraft(e.target.value)
            commitDraft(e.target.value)
          }}
          onBlur={() => setDraft('')}
          className="w-22 h-6 font-mono text-[11px] bg-muted/50 border-border"
        />
        <label
          className="relative size-5 rounded-[8px] shrink-0 cursor-pointer border border-border overflow-hidden"
          style={{ backgroundColor: shown }}
          title={t('appearance.customThemes.editor.pickColor')}
        >
          <input
            type="color"
            value={pickerValue}
            aria-label={t('appearance.customThemes.editor.pickColor')}
            onChange={(e) => onChange(def.cssVar, e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
        <button
          type="button"
          aria-label={t('appearance.customThemes.editor.reset')}
          title={t('appearance.customThemes.editor.reset')}
          onClick={() => onChange(def.cssVar, null)}
          disabled={!override}
          className={cn(
            'p-0.5 rounded transition-colors',
            override
              ? 'text-muted-foreground hover:text-foreground cursor-pointer'
              : 'text-transparent pointer-events-none'
          )}
        >
          <RotateCcw className="size-3" />
        </button>
      </div>
    </div>
  )
}

interface ThemeEditorProps {
  theme: CustomTheme
  isActive: boolean
  onClose: () => void
  onUpdate: (
    id: string,
    updates: { name?: string; variables?: Record<string, string> }
  ) => Promise<CustomTheme | null>
}

function ThemeEditor({ theme, isActive, onClose, onUpdate }: ThemeEditorProps) {
  const { t } = useT('settings')
  const [name, setName] = useState(theme.name)
  const [variables, setVariables] = useState<Record<string, string>>(theme.variables)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setName(theme.name)
    setVariables(theme.variables)
  }, [theme.id])

  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [])

  const persistVariables = useCallback(
    (next: Record<string, string>) => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => {
        void onUpdate(theme.id, { variables: next }).then((updated) => {
          if (!updated) toast.error(t('appearance.customThemes.errors.update'))
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [onUpdate, t, theme.id]
  )

  const setVariable = useCallback(
    (cssVar: string, value: string | null) => {
      setVariables((current) => {
        const next = { ...current }
        if (value === null) {
          delete next[cssVar]
        } else {
          next[cssVar] = value
        }
        // Live preview: the app itself is the preview surface.
        if (isActive) applyCustomThemeVariables(document.documentElement, next)
        persistVariables(next)
        return next
      })
    },
    [isActive, persistVariables]
  )

  const resetAll = useCallback(() => {
    setVariables({})
    if (isActive) applyCustomThemeVariables(document.documentElement, {})
    persistVariables({})
  }, [isActive, persistVariables])

  const commitName = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === theme.name) return
    void onUpdate(theme.id, { name: trimmed }).then((updated) => {
      if (!updated) toast.error(t('appearance.customThemes.errors.update'))
    })
  }, [name, onUpdate, t, theme.id, theme.name])

  const sections = useMemo(() => {
    const byGroup = (group: 'core' | 'advanced') =>
      SECTION_ORDER.map((section) => ({
        section,
        defs: THEME_VARIABLES.filter((def) => def.group === group && def.section === section)
      })).filter((entry) => entry.defs.length > 0)
    return { core: byGroup('core'), advanced: byGroup('advanced') }
  }, [])

  const renderSections = (entries: { section: string; defs: ThemeVariableDef[] }[]): ReactNode =>
    entries.map(({ section, defs }) => (
      <div key={section} className="pb-1">
        <div className="px-4 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {t(`appearance.customThemes.editor.sections.${section}`)}
        </div>
        {defs.map((def) => (
          <VariableRow
            key={def.cssVar}
            def={def}
            override={variables[def.cssVar]}
            onChange={setVariable}
          />
        ))}
      </div>
    ))

  return (
    <div className="border-t border-border bg-muted/20">
      <div className="flex items-center justify-between gap-2 py-2.5 px-4">
        <div className="flex items-center gap-2 min-w-0">
          <Input
            value={name}
            aria-label={t('appearance.customThemes.editor.name')}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && commitName()}
            className="w-40 h-7 text-xs bg-muted/50 border-border"
            maxLength={64}
          />
          <span className="text-[11px] text-muted-foreground shrink-0">
            {t('appearance.customThemes.editor.base')}:{' '}
            {t(`appearance.theme.options.${theme.base}`)}
          </span>
        </div>
        <div className="flex items-center shrink-0 gap-2">
          <button
            type="button"
            onClick={resetAll}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {t('appearance.customThemes.editor.resetAll')}
          </button>
          <button
            type="button"
            aria-label={t('appearance.customThemes.editor.close')}
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {renderSections(sections.core)}

      <button
        type="button"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex w-full items-center gap-1.5 py-2 px-4 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors cursor-pointer"
      >
        <ChevronDown className={cn('size-3 transition-transform', !showAdvanced && '-rotate-90')} />
        {t('appearance.customThemes.editor.advanced')}
      </button>
      {showAdvanced && renderSections(sections.advanced)}
    </div>
  )
}

export function CustomThemesSection() {
  const { t } = useT('settings')
  const { settings, updateSettings } = useGeneralSettings()
  const { themes, createTheme, updateTheme, deleteTheme } = useCustomThemes()
  const [editingId, setEditingId] = useState<string | null>(null)

  const editingTheme = themes.find((theme) => theme.id === editingId) ?? null

  const handleCreate = useCallback(async () => {
    const base = baseForCurrentTheme(settings.theme)
    const name = `${t('appearance.customThemes.newNamePrefix')} ${themes.length + 1}`
    const theme = await createTheme({ name, base })
    if (!theme) {
      toast.error(t('appearance.customThemes.errors.create'))
      return
    }
    const applied = await updateSettings({ customThemeId: theme.id, theme: theme.base })
    if (!applied) toast.error(t('appearance.customThemes.errors.apply'))
    setEditingId(theme.id)
  }, [createTheme, settings.theme, t, themes.length, updateSettings])

  const handleApply = useCallback(
    async (theme: CustomTheme) => {
      const success = await updateSettings({ customThemeId: theme.id, theme: theme.base })
      if (!success) toast.error(t('appearance.customThemes.errors.apply'))
    },
    [t, updateSettings]
  )

  const handleDuplicate = useCallback(
    async (theme: CustomTheme) => {
      const copy = await createTheme({
        name: `${theme.name} ${t('appearance.customThemes.copySuffix')}`,
        base: theme.base,
        variables: theme.variables
      })
      if (!copy) toast.error(t('appearance.customThemes.errors.create'))
    },
    [createTheme, t]
  )

  const handleDelete = useCallback(
    async (theme: CustomTheme) => {
      const wasActive = settings.customThemeId === theme.id
      const success = await deleteTheme(theme.id)
      if (!success) {
        toast.error(t('appearance.customThemes.errors.delete'))
        return
      }
      if (editingId === theme.id) setEditingId(null)
      if (wasActive) {
        // Fall back to the deleted theme's base.
        await updateSettings({ customThemeId: null, theme: theme.base })
      }
    },
    [deleteTheme, editingId, settings.customThemeId, t, updateSettings]
  )

  return (
    <SettingsGroup label={t('appearance.customThemes.group')}>
      {themes.length === 0 && (
        <div className="py-3 px-4 text-xs text-muted-foreground">
          {t('appearance.customThemes.empty')}
        </div>
      )}

      {themes.map((theme) => {
        const isActive = settings.customThemeId === theme.id
        return (
          <div key={theme.id} className="border-b border-border/50 last:border-b-0">
            <div className="flex items-center justify-between gap-2 py-2.5 px-4">
              <button
                type="button"
                onClick={() => void handleApply(theme)}
                className="flex items-center gap-2 min-w-0 cursor-pointer group"
                title={t('appearance.customThemes.apply')}
              >
                <span
                  className={cn(
                    'flex items-center justify-center size-4 rounded-full border shrink-0',
                    isActive ? 'bg-tint border-tint text-tint-foreground' : 'border-border'
                  )}
                >
                  {isActive && <Check className="size-2.5" />}
                </span>
                <span className="text-[13px]/4 font-medium text-foreground truncate group-hover:text-tint transition-colors">
                  {theme.name}
                </span>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {t(`appearance.theme.options.${theme.base}`)}
                </span>
                {isActive && (
                  <span className="text-[11px] text-tint shrink-0">
                    {t('appearance.customThemes.active')}
                  </span>
                )}
              </button>
              <div className="flex items-center shrink-0 gap-1">
                <button
                  type="button"
                  aria-label={t('appearance.customThemes.edit')}
                  title={t('appearance.customThemes.edit')}
                  onClick={() => setEditingId(editingId === theme.id ? null : theme.id)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('appearance.customThemes.duplicate')}
                  title={t('appearance.customThemes.duplicate')}
                  onClick={() => void handleDuplicate(theme)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <Copy className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('appearance.customThemes.delete')}
                  title={t('appearance.customThemes.delete')}
                  onClick={() => void handleDelete(theme)}
                  className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
            {editingTheme?.id === theme.id && (
              <ThemeEditor
                theme={editingTheme}
                isActive={isActive}
                onClose={() => setEditingId(null)}
                onUpdate={updateTheme}
              />
            )}
          </div>
        )
      })}

      <button
        type="button"
        onClick={() => void handleCreate()}
        className="flex w-full items-center gap-1.5 py-2.5 px-4 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <Plus className="size-3.5" />
        {t('appearance.customThemes.new')}
      </button>
    </SettingsGroup>
  )
}
