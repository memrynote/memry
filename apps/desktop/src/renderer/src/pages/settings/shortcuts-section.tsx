import { useState, useCallback, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Badge } from '@/components/ui/badge'
import { Search, RotateCcw, X, AlertTriangle, Info } from '@/lib/icons'
import { useKeyboardSettings } from '@/hooks/use-keyboard-settings'
import { trackRendererLog } from '@/lib/telemetry-diagnostics'
import { toast } from 'sonner'
import type { GlobalCaptureResult, ShortcutBinding } from '@memry/contracts/settings-schemas'
import type { ShortcutBindingDTO } from '../../../../preload/index.d'
import {
  SHORTCUT_REGISTRY,
  CATEGORY_ORDER,
  formatBinding,
  resolveBinding,
  findConflicts,
  bindingsEqual,
  getGroupedShortcuts,
  type ShortcutEntry
} from '@/lib/shortcut-registry'
import { SettingsHeader, SettingsGroup } from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'

type SettingsT = ReturnType<typeof useT>['t']

const CATEGORY_I18N_KEYS: Record<string, string> = {
  Navigation: 'navigation',
  Tabs: 'tabs',
  Editor: 'editor',
  View: 'view'
}

function shortcutLabel(t: SettingsT, entry: ShortcutEntry): string {
  return t(`shortcuts.entries.${entry.i18nKey}.label`)
}

function shortcutDescription(t: SettingsT, entry: ShortcutEntry): string {
  return t(`shortcuts.entries.${entry.i18nKey}.description`)
}

function shortcutCategoryLabel(t: SettingsT, category: string): string {
  const key = CATEGORY_I18N_KEYS[category]
  return key ? t(`shortcuts.categories.${key}`) : category
}

interface ShortcutRowProps {
  entry: ShortcutEntry
  effectiveBinding: ShortcutBinding
  isDefault: boolean
  overrides: Record<string, ShortcutBinding>
  onRebind: (id: string, binding: ShortcutBinding) => Promise<void>
  onClearOverride: (id: string) => Promise<void>
}

function ShortcutRow({
  entry,
  effectiveBinding,
  isDefault,
  overrides,
  onRebind,
  onClearOverride
}: ShortcutRowProps) {
  const { t } = useT('settings')
  const [isCapturing, setIsCapturing] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const captureRef = useRef<HTMLDivElement>(null)

  const startCapture = useCallback(() => {
    if (entry.rebindable === false) return
    setIsCapturing(true)
    setConflict(null)
  }, [entry.rebindable])

  const stopCapture = useCallback(() => {
    setIsCapturing(false)
    setConflict(null)
  }, [])

  useEffect(() => {
    if (!isCapturing) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        stopCapture()
        return
      }

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return

      const newBinding: ShortcutBinding = {
        key: e.key,
        modifiers: {
          meta: e.metaKey || e.ctrlKey,
          shift: e.shiftKey || undefined,
          alt: e.altKey || undefined
        }
      }

      const conflicts = findConflicts(entry.id, newBinding, overrides)
      if (conflicts.length > 0) {
        const labels = conflicts.map((conflict) => {
          const conflictingEntry = SHORTCUT_REGISTRY.find((e) => e.id === conflict.conflictingId)
          return conflictingEntry ? shortcutLabel(t, conflictingEntry) : conflict.conflictingLabel
        })
        setConflict(t('shortcuts.conflict', { labels: labels.join(', ') }))
        return
      }

      setIsCapturing(false)
      setConflict(null)
      void onRebind(entry.id, newBinding)
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isCapturing, entry.id, overrides, onRebind, stopCapture, t])

  const label = shortcutLabel(t, entry)
  // Editor formatting keys belong to the note editor; a rebind here would be
  // recorded and then ignored at runtime, so the row is read-only.
  const canRebind = entry.rebindable !== false
  const keyCaps = formatBinding(effectiveBinding)
    .split(' ')
    .map((part) => <Kbd key={part}>{part}</Kbd>)

  useEffect(() => {
    if (!isCapturing) return
    const handleClick = (e: MouseEvent): void => {
      if (captureRef.current && !captureRef.current.contains(e.target as Node)) {
        stopCapture()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isCapturing, stopCapture])

  return (
    <>
      <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-[13px]/4 text-foreground">{label}</span>
          {!isDefault && (
            <Badge
              variant="secondary"
              className="text-[10px]/3 px-1.5 py-0 h-4 bg-[var(--tint)]/15 text-[var(--tint)] border-0"
            >
              {t('shortcuts.custom')}
            </Badge>
          )}
        </div>

        <div ref={captureRef} className="flex items-center gap-2 ms-4 shrink-0">
          {isCapturing ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--tint)] bg-[var(--tint)]/5 text-xs text-[var(--tint)] animate-pulse">
                {t('shortcuts.pressShortcut')}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={stopCapture}
                className="h-7 w-7 p-0"
                title={t('shortcuts.cancelTitle')}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {canRebind ? (
                <button
                  type="button"
                  onClick={startCapture}
                  className="flex items-center gap-0.5 hover:opacity-70 transition-opacity"
                  title={t('shortcuts.rebindTitle')}
                >
                  <KbdGroup>{keyCaps}</KbdGroup>
                </button>
              ) : (
                <span
                  className="flex items-center gap-0.5 opacity-60"
                  title={t('shortcuts.editorManagedTitle')}
                >
                  <KbdGroup>{keyCaps}</KbdGroup>
                </span>
              )}
              {canRebind && !isDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onClearOverride(entry.id)}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  title={t('shortcuts.resetTitle')}
                >
                  <RotateCcw className="w-3 h-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {conflict && <p className="text-[10px]/3 text-destructive px-4 pb-2">{conflict}</p>}
    </>
  )
}

const PLATFORM = window.navigator.platform.toLowerCase()
const IS_MACOS = PLATFORM.includes('mac')

const DEFAULT_GLOBAL_CAPTURE: ShortcutBindingDTO = {
  key: 'Space',
  modifiers: { meta: true, shift: true }
}

function getGlobalCaptureParts(binding: ShortcutBindingDTO): string[] {
  const { key, modifiers } = binding
  const parts: string[] = []
  if (modifiers.meta) parts.push(IS_MACOS ? '⌘' : 'Ctrl')
  if (modifiers.ctrl && !modifiers.meta) parts.push('Ctrl')
  if (modifiers.alt) parts.push(IS_MACOS ? '⌥' : 'Alt')
  if (modifiers.shift) parts.push(IS_MACOS ? '⇧' : 'Shift')
  parts.push(key.toUpperCase())
  return parts
}

function formatGlobalCapture(binding: ShortcutBindingDTO): string {
  return getGlobalCaptureParts(binding).join(IS_MACOS ? '' : '+')
}

const ACCELERATOR_KEYS_BY_CODE: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/**
 * Electron accelerators only accept ASCII key names, and `KeyboardEvent.key`
 * breaks that: macOS reports Option+K as "˚" and Space as " ". Read the
 * physical key instead.
 */
function acceleratorKey(event: KeyboardEvent): string | null {
  const { code } = event
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  return ACCELERATOR_KEYS_BY_CODE[code] ?? null
}

type GlobalCaptureRowStatus =
  | { kind: 'unknown' }
  | { kind: 'active' }
  | { kind: 'permissionRequired' }
  | { kind: 'rejected'; reason: 'in_use' | 'unsupported'; binding: ShortcutBindingDTO }
  | { kind: 'fallbackInUse' }

function toRowStatus(
  result: GlobalCaptureResult,
  binding: ShortcutBindingDTO | null
): GlobalCaptureRowStatus {
  switch (result.status) {
    case 'registered':
      return { kind: 'active' }
    case 'permission_required':
      return { kind: 'permissionRequired' }
    case 'in_use':
    case 'unsupported':
      return binding ? { kind: 'rejected', reason: result.status, binding } : { kind: 'unknown' }
    case 'unbound':
      return result.fallbackRegistered ? { kind: 'unknown' } : { kind: 'fallbackInUse' }
  }
}

const REJECTION_I18N_KEYS = {
  in_use: 'shortcuts.globalCapture.inUse',
  unsupported: 'shortcuts.globalCapture.unsupported'
} as const

function globalCaptureProblem(t: SettingsT, status: GlobalCaptureRowStatus): string | null {
  if (status.kind === 'rejected') {
    return t(REJECTION_I18N_KEYS[status.reason], { shortcut: formatGlobalCapture(status.binding) })
  }
  if (status.kind === 'fallbackInUse') {
    return t('shortcuts.globalCapture.fallbackInUse', {
      shortcut: formatGlobalCapture(DEFAULT_GLOBAL_CAPTURE)
    })
  }
  return null
}

function GlobalCaptureRow({ binding }: { binding: ShortcutBindingDTO | null }): React.JSX.Element {
  const { t } = useT('settings')
  const [isCapturing, setIsCapturing] = useState(false)
  const [status, setStatus] = useState<GlobalCaptureRowStatus>({ kind: 'unknown' })
  const captureRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.settings.registerGlobalCapture().then((result) => {
      if (!cancelled) setStatus(toRowStatus(result, binding))
    })
    return () => {
      cancelled = true
    }
  }, [binding])

  const save = useCallback(
    async (next: ShortcutBindingDTO | null): Promise<void> => {
      try {
        setStatus(toRowStatus(await window.api.settings.setGlobalCapture(next), next))
      } catch {
        trackRendererLog('warn', 'keyboard_settings_save_failed', 'Settings')
        toast.error(t('shortcuts.toasts.saveGlobalFailed'))
      }
    },
    [t]
  )

  const startCapture = useCallback(() => setIsCapturing(true), [])
  const stopCapture = useCallback(() => setIsCapturing(false), [])

  useEffect(() => {
    if (!isCapturing) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        stopCapture()
        return
      }
      const key = acceleratorKey(e)
      if (!key) return
      const newBinding: ShortcutBindingDTO = {
        key,
        modifiers: {
          meta: e.metaKey || e.ctrlKey || undefined,
          shift: e.shiftKey || undefined,
          alt: e.altKey || undefined
        }
      }
      setIsCapturing(false)
      void save(newBinding)
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isCapturing, save, stopCapture])

  useEffect(() => {
    if (!isCapturing) return
    const handleClick = (e: MouseEvent): void => {
      if (captureRef.current && !captureRef.current.contains(e.target as Node)) {
        stopCapture()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isCapturing, stopCapture])

  const problem = globalCaptureProblem(t, status)

  return (
    <>
      <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-[13px]/4 text-foreground">
            {t('shortcuts.globalCapture.title')}
          </span>
          {status.kind === 'permissionRequired' && (
            <Badge variant="destructive" className="text-[10px]/3 px-1.5 py-0 h-4 gap-1">
              <AlertTriangle className="w-3 h-3" />
              {t('shortcuts.globalCapture.permissionNeeded')}
            </Badge>
          )}
          {status.kind === 'active' && (
            <Badge
              variant="secondary"
              className="text-[10px]/3 px-1.5 py-0 h-4 bg-green-500/15 text-green-600 border-0"
            >
              {t('shortcuts.globalCapture.active')}
            </Badge>
          )}
          <span className="text-xs/4 text-muted-foreground">
            {t('shortcuts.globalCapture.description')}
          </span>
        </div>

        <div ref={captureRef} className="flex items-center gap-2 ms-4 shrink-0">
          {isCapturing ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--tint)] bg-[var(--tint)]/5 text-xs text-[var(--tint)] animate-pulse">
                {t('shortcuts.pressShortcut')}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={stopCapture}
                className="h-7 w-7 p-0"
                title={t('shortcuts.cancelTitle')}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {binding ? (
                <button
                  type="button"
                  onClick={startCapture}
                  className="flex items-center gap-0.5 hover:opacity-70 transition-opacity"
                  title={t('shortcuts.rebindTitle')}
                >
                  <KbdGroup>
                    {getGlobalCaptureParts(binding).map((part) => (
                      <Kbd key={part}>{part}</Kbd>
                    ))}
                  </KbdGroup>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startCapture}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-dashed border-border"
                >
                  {t('shortcuts.clickToSet')}
                </button>
              )}
              {binding && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void save(null)}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  title={t('shortcuts.clearTitle')}
                >
                  <X className="w-3 h-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {problem && (
        <p role="alert" className="text-[10px]/3 text-destructive px-4 pb-2">
          {problem}
        </p>
      )}
      {status.kind === 'permissionRequired' && IS_MACOS && (
        <div className="flex items-start gap-2 mx-4 mb-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-[10px]/3 text-amber-800 dark:text-amber-300">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{t('shortcuts.globalCapture.permissionHint')}</span>
        </div>
      )}
    </>
  )
}

export function ShortcutsSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings, resetToDefaults } = useKeyboardSettings()
  const [query, setQuery] = useState('')

  const overrides = settings.overrides
  const globalCapture = settings.globalCapture ?? null

  const handleRebind = useCallback(
    async (id: string, binding: ShortcutBinding): Promise<void> => {
      const entry = SHORTCUT_REGISTRY.find((e) => e.id === id)
      if (!entry) return

      if (bindingsEqual(binding, entry.defaultBinding)) {
        const newOverrides = { ...overrides }
        delete newOverrides[id]
        const success = await updateSettings({ overrides: newOverrides })
        if (!success) {
          trackRendererLog('warn', 'keyboard_settings_save_failed', 'Settings')
          toast.error(t('shortcuts.toasts.saveFailed'))
        }
        return
      }

      const success = await updateSettings({ overrides: { ...overrides, [id]: binding } })
      if (!success) {
        trackRendererLog('warn', 'keyboard_settings_save_failed', 'Settings')
        toast.error(t('shortcuts.toasts.saveFailed'))
      }
    },
    [overrides, updateSettings, t]
  )

  const handleClearOverride = useCallback(
    async (id: string): Promise<void> => {
      const newOverrides = { ...overrides }
      delete newOverrides[id]
      const success = await updateSettings({ overrides: newOverrides })
      if (!success) {
        trackRendererLog('warn', 'keyboard_settings_reset_failed', 'Settings')
        toast.error(t('shortcuts.toasts.resetFailed'))
      }
    },
    [overrides, updateSettings, t]
  )

  const handleResetAll = useCallback(async () => {
    const success = await resetToDefaults()
    if (success) toast.success(t('shortcuts.toasts.resetAllSuccess'))
    else {
      trackRendererLog('warn', 'keyboard_settings_reset_failed', 'Settings')
      toast.error(t('shortcuts.toasts.resetAllFailed'))
    }
  }, [resetToDefaults, t])

  const lowerQuery = query.toLowerCase()
  const grouped = getGroupedShortcuts()

  const filteredGroups: [string, ShortcutEntry[]][] = CATEGORY_ORDER.flatMap((cat) => {
    const entries = grouped.get(cat) ?? []
    const filtered = query
      ? entries.filter(
          (e) =>
            shortcutLabel(t, e).toLowerCase().includes(lowerQuery) ||
            shortcutDescription(t, e).toLowerCase().includes(lowerQuery)
        )
      : entries
    return filtered.length > 0 ? [[cat, filtered] as [string, ShortcutEntry[]]] : []
  })

  const hasCustomBindings = Object.keys(overrides).length > 0

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader
          title={t('shortcuts.header.title')}
          subtitle={t('shortcuts.header.loading')}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title={t('shortcuts.header.title')}
        subtitle={t('shortcuts.header.subtitle')}
        action={
          hasCustomBindings ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleResetAll()}
              className="gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('shortcuts.resetAll')}
            </Button>
          ) : undefined
        }
      />

      <div className="relative pb-6">
        <Search className="absolute start-3 top-2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder={t('shortcuts.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ps-8 h-8 text-xs/4 rounded-lg border-border bg-transparent"
        />
      </div>

      <SettingsGroup label={t('shortcuts.globalCapture.title')}>
        <GlobalCaptureRow binding={globalCapture} />
      </SettingsGroup>

      {filteredGroups.length === 0 && (
        <p className="text-xs/4 text-muted-foreground text-center py-4">{t('shortcuts.noMatch')}</p>
      )}

      {filteredGroups.map(([category, entries]) => (
        <SettingsGroup key={category} label={shortcutCategoryLabel(t, category)}>
          {entries.map((entry) => {
            const effectiveBinding = resolveBinding(entry, overrides)
            const isDefault = !overrides[entry.id]
            return (
              <ShortcutRow
                key={entry.id}
                entry={entry}
                effectiveBinding={effectiveBinding}
                isDefault={isDefault}
                overrides={overrides}
                onRebind={handleRebind}
                onClearOverride={handleClearOverride}
              />
            )
          })}
        </SettingsGroup>
      ))}
    </div>
  )
}
