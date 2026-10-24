import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Search, X, Pencil, Trash2, Undo } from '@/lib/icons'
import { useKeyboardSettings } from '@/hooks/use-keyboard-settings'
import { trackRendererLog } from '@/lib/telemetry-diagnostics'
import { toast } from 'sonner'
import type {
  FolderNoteShortcut,
  GlobalCaptureResult,
  ShortcutBinding
} from '@memry/contracts/settings-schemas'
import type { ShortcutBindingDTO } from '../../../../preload/index.d'
import type { CommandGroup } from '@memry/contracts/commands'
import {
  SHORTCUT_ENTRIES,
  SHORTCUT_GROUP_ORDER,
  bindingParts,
  resolveBinding,
  findConflicts,
  bindingsEqual,
  getGroupedShortcuts,
  type ShortcutEntry
} from '@/lib/shortcut-catalog'
import {
  SettingsHeader,
  SettingsGroup,
  SEGMENTED,
  SEGMENT_ITEM
} from '@/components/settings/settings-primitives'
import { bindingFromKeyboardEvent } from '@/hooks/use-keyboard-shortcuts-base'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import {
  ICON_BUTTON,
  KEYCAP,
  MODIFIER_KEYS,
  PENCIL,
  PILL,
  QUIET_BUTTON,
  REBIND_BUTTON,
  RECORDING_ROW,
  ROW,
  RecordingBar,
  conflictMessage,
  useShortcutCapture,
  type SettingsT
} from './shortcut-capture'
import { FolderNoteShortcutsGroup } from './folder-note-shortcuts-group'

const ALL_CATEGORIES = 'all'

function shortcutLabel(t: SettingsT, entry: ShortcutEntry): string {
  return t(`shortcuts.entries.${entry.i18nKey}.label`)
}

function shortcutDescription(t: SettingsT, entry: ShortcutEntry): string {
  return t(`shortcuts.entries.${entry.i18nKey}.description`)
}

function shortcutCategoryLabel(t: SettingsT, group: CommandGroup): string {
  return t(`shortcuts.categories.${group}`)
}

interface ShortcutRowProps {
  entry: ShortcutEntry
  effectiveBinding: ShortcutBinding
  isDefault: boolean
  overrides: Record<string, ShortcutBinding>
  folderNoteShortcuts: FolderNoteShortcut[]
  onRebind: (id: string, binding: ShortcutBinding) => Promise<void>
  onClearOverride: (id: string) => Promise<void>
}

function ShortcutRow({
  entry,
  effectiveBinding,
  isDefault,
  overrides,
  folderNoteShortcuts,
  onRebind,
  onClearOverride
}: ShortcutRowProps) {
  const { t } = useT('settings')
  const [conflict, setConflict] = useState<string | null>(null)
  const capture = useShortcutCapture(
    (e, stop) => {
      if (MODIFIER_KEYS.includes(e.key)) return
      const newBinding = bindingFromKeyboardEvent(e)
      const conflicts = findConflicts(entry.id, newBinding, overrides, folderNoteShortcuts)
      if (conflicts.length > 0) {
        setConflict(conflictMessage(t, conflicts))
        return
      }
      setConflict(null)
      stop()
      void onRebind(entry.id, newBinding)
    },
    {
      onCancel: () => setConflict(null)
    }
  )
  const { isCapturing, captureRef, cancel: stopCapture } = capture

  const startCapture = (): void => {
    if (entry.rebindable === false) return
    capture.start()
  }

  const label = shortcutLabel(t, entry)
  // Editor formatting keys belong to the note editor; a rebind here would be
  // recorded and then ignored at runtime, so the row is read-only.
  const canRebind = entry.rebindable
  const keyCaps = bindingParts(effectiveBinding).map((part) => (
    <Kbd key={part} className={KEYCAP}>
      {part}
    </Kbd>
  ))

  return (
    <div className={cn(ROW, isCapturing && RECORDING_ROW)}>
      {isCapturing && <RecordingBar />}
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px]/4 text-foreground">{label}</span>
        {conflict ? (
          <span className="text-xs/4 text-destructive">{conflict}</span>
        ) : (
          <span className="text-xs/4 text-muted-foreground">
            {isCapturing ? t('shortcuts.v2.recordingHint') : shortcutDescription(t, entry)}
          </span>
        )}
      </div>

      <div ref={captureRef} className="flex items-center gap-2.5 min-w-0">
        {isCapturing ? (
          <>
            <span className="text-xs/4 text-foreground">{t('shortcuts.pressShortcut')}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={stopCapture}
              className="size-6 p-0 text-muted-foreground hover:text-foreground"
              title={t('shortcuts.cancelTitle')}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          <>
            {canRebind ? (
              <button
                type="button"
                onClick={startCapture}
                className={REBIND_BUTTON}
                title={t('shortcuts.rebindTitle')}
              >
                <KbdGroup className={PILL}>{keyCaps}</KbdGroup>
                <Pencil aria-hidden="true" className={PENCIL} />
              </button>
            ) : (
              <span
                className="flex items-center opacity-60"
                title={t('shortcuts.editorManagedTitle')}
              >
                <KbdGroup className={PILL}>{keyCaps}</KbdGroup>
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex justify-end">
        {canRebind && !isDefault && !isCapturing && (
          <button
            type="button"
            onClick={() => void onClearOverride(entry.id)}
            className={ICON_BUTTON}
            title={t('shortcuts.resetTitle')}
            aria-label={t('shortcuts.resetTitle')}
          >
            <Undo className="size-3.5" />
          </button>
        )}
      </div>
    </div>
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
  | { kind: 'rejected'; reason: 'in_use' | 'unsupported'; binding: ShortcutBindingDTO }
  | { kind: 'fallbackInUse' }

// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch over a closed union with no default; adding one would drop the compile-time exhaustiveness check
function toRowStatus(
  result: GlobalCaptureResult,
  binding: ShortcutBindingDTO | null
): GlobalCaptureRowStatus {
  switch (result.status) {
    case 'registered':
      return { kind: 'active' }
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

/** The two system-wide shortcuts: Quick Capture and the sticky. */
const SYSTEM_SHORTCUTS = {
  globalCapture: {
    labelKey: 'shortcuts.v2.globalCapture',
    descriptionKey: 'shortcuts.globalCapture.description',
    saveFailedKey: 'shortcuts.toasts.saveGlobalFailed',
    register: () => window.api.settings.registerGlobalCapture(),
    save: (binding: ShortcutBindingDTO | null) => window.api.settings.setGlobalCapture(binding)
  },
  sticky: {
    labelKey: 'shortcuts.v2.sticky',
    descriptionKey: 'shortcuts.sticky.description',
    saveFailedKey: 'shortcuts.toasts.saveStickyFailed',
    // The sticky has no built-in fallback, so an unbound sticky is not a problem.
    register: async (): Promise<GlobalCaptureResult> => ({
      ...(await window.api.settings.registerStickyShortcut()),
      fallbackRegistered: true
    }),
    save: async (binding: ShortcutBindingDTO | null): Promise<GlobalCaptureResult> => ({
      ...(await window.api.settings.setStickyShortcut(binding)),
      fallbackRegistered: true
    })
  }
} as const

function SystemShortcutRow({
  shortcut,
  binding
}: {
  shortcut: keyof typeof SYSTEM_SHORTCUTS
  binding: ShortcutBindingDTO | null
}): React.JSX.Element {
  const { t } = useT('settings')
  const config = SYSTEM_SHORTCUTS[shortcut]
  const [status, setStatus] = useState<GlobalCaptureRowStatus>({ kind: 'unknown' })

  useEffect(() => {
    let cancelled = false
    void config.register().then((result) => {
      if (!cancelled) setStatus(toRowStatus(result, binding))
    })
    return () => {
      cancelled = true
    }
  }, [config, binding])

  const save = useCallback(
    async (next: ShortcutBindingDTO | null): Promise<void> => {
      try {
        setStatus(toRowStatus(await config.save(next), next))
      } catch {
        trackRendererLog('warn', 'keyboard_settings_save_failed', 'Settings')
        toast.error(t(config.saveFailedKey))
      }
    },
    [config, t]
  )

  const capture = useShortcutCapture((e, stop) => {
    const key = acceleratorKey(e)
    if (!key) return
    stop()
    void save({
      key,
      modifiers: {
        meta: e.metaKey || e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined
      }
    })
  })
  const { isCapturing, captureRef, start: startCapture, cancel: stopCapture } = capture

  const problem = globalCaptureProblem(t, status)

  return (
    <div className={cn(ROW, isCapturing && RECORDING_ROW)}>
      {isCapturing && <RecordingBar />}
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px]/4 text-foreground">{t(config.labelKey)}</span>
          {status.kind === 'active' && (
            <span className="flex items-center gap-1.5 text-xs/4 text-muted-foreground">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-green-500" />
              {t('shortcuts.globalCapture.active')}
            </span>
          )}
        </div>
        <span className="text-xs/4 text-muted-foreground">
          {isCapturing ? t('shortcuts.v2.recordingHint') : t(config.descriptionKey)}
        </span>
        {problem && (
          <span role="alert" className="text-xs/4 text-destructive">
            {problem}
          </span>
        )}
      </div>

      <div ref={captureRef} className="flex items-center gap-2.5 min-w-0">
        {isCapturing ? (
          <>
            <span className="text-xs/4 text-foreground">{t('shortcuts.pressShortcut')}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={stopCapture}
              className="size-6 p-0 text-muted-foreground hover:text-foreground"
              title={t('shortcuts.cancelTitle')}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : binding ? (
          <button
            type="button"
            onClick={startCapture}
            className={REBIND_BUTTON}
            title={t('shortcuts.rebindTitle')}
          >
            <KbdGroup className={PILL}>
              {getGlobalCaptureParts(binding).map((part) => (
                <Kbd key={part} className={KEYCAP}>
                  {part}
                </Kbd>
              ))}
            </KbdGroup>
            <Pencil aria-hidden="true" className={PENCIL} />
          </button>
        ) : (
          <button type="button" onClick={startCapture} className={REBIND_BUTTON}>
            <span className="text-[13px]/4 text-muted-foreground">{t('shortcuts.clickToSet')}</span>
            <Pencil aria-hidden="true" className={PENCIL} />
          </button>
        )}
      </div>

      <div className="flex justify-end">
        {binding && !isCapturing && (
          <button
            type="button"
            onClick={() => void save(null)}
            className={ICON_BUTTON}
            title={t('shortcuts.clearTitle')}
            aria-label={t('shortcuts.clearTitle')}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export function ShortcutsSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings, resetToDefaults } = useKeyboardSettings()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>(ALL_CATEGORIES)

  const overrides = settings.overrides
  const globalCapture = settings.globalCapture ?? null
  const stickyShortcut = settings.stickyShortcut ?? null
  const folderNoteShortcuts = settings.folderNoteShortcuts ?? []

  const handleRebind = useCallback(
    async (id: string, binding: ShortcutBinding): Promise<void> => {
      const entry = SHORTCUT_ENTRIES.find((e) => e.id === id)
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

  const visibleCategories =
    category === ALL_CATEGORIES
      ? SHORTCUT_GROUP_ORDER
      : SHORTCUT_GROUP_ORDER.filter((group) => group === category)
  const filteredGroups: [CommandGroup, ShortcutEntry[]][] = visibleCategories.flatMap((cat) => {
    const entries = grouped.get(cat) ?? []
    const filtered = query
      ? entries.filter(
          (e) =>
            shortcutLabel(t, e).toLowerCase().includes(lowerQuery) ||
            shortcutDescription(t, e).toLowerCase().includes(lowerQuery)
        )
      : entries
    return filtered.length > 0 ? [[cat, filtered] as [CommandGroup, ShortcutEntry[]]] : []
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
      />

      <div className="flex items-center gap-3 pb-6">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder={t('shortcuts.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 ps-8 text-xs/4 rounded-md border-border bg-transparent shadow-none"
          />
        </div>
        <ToggleGroup
          type="single"
          value={category}
          onValueChange={(value) => {
            if (value) setCategory(value)
          }}
          aria-label={t('shortcuts.v2.categoryFilter')}
          className={cn(SEGMENTED, 'shrink-0')}
        >
          <ToggleGroupItem value={ALL_CATEGORIES} className={SEGMENT_ITEM}>
            {t('shortcuts.v2.all')}
          </ToggleGroupItem>
          {SHORTCUT_GROUP_ORDER.map((cat) => (
            <ToggleGroupItem key={cat} value={cat} className={SEGMENT_ITEM}>
              {shortcutCategoryLabel(t, cat)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {category === ALL_CATEGORIES && (
        <SettingsGroup label={t('shortcuts.v2.systemWide')}>
          <SystemShortcutRow shortcut="globalCapture" binding={globalCapture} />
          <SystemShortcutRow shortcut="sticky" binding={stickyShortcut} />
        </SettingsGroup>
      )}

      {category === ALL_CATEGORIES && !query && (
        <FolderNoteShortcutsGroup
          entries={folderNoteShortcuts}
          overrides={overrides}
          onChange={(next) => updateSettings({ folderNoteShortcuts: next })}
        />
      )}

      {filteredGroups.length === 0 && (
        <p className="text-xs/4 text-muted-foreground text-center py-4">{t('shortcuts.noMatch')}</p>
      )}

      {filteredGroups.map(([groupCategory, entries]) => (
        <SettingsGroup key={groupCategory} label={shortcutCategoryLabel(t, groupCategory)}>
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
                folderNoteShortcuts={folderNoteShortcuts}
                onRebind={handleRebind}
                onClearOverride={handleClearOverride}
              />
            )
          })}
        </SettingsGroup>
      ))}

      {hasCustomBindings && (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="shortcuts-reset-all"
            onClick={() => void handleResetAll()}
            className={QUIET_BUTTON}
          >
            {t('shortcuts.v2.resetAll')}
          </button>
        </div>
      )}
    </div>
  )
}
