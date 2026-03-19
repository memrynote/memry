import { useState, useCallback, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Badge } from '@/components/ui/badge'
import { Search, RotateCcw, X, AlertTriangle, Info } from '@/lib/icons'
import { useKeyboardSettings } from '@/hooks/use-keyboard-settings'
import { toast } from 'sonner'
import type { ShortcutBinding } from '@memry/contracts/settings-schemas'
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

// ============================================================================
// Key Capture Row
// ============================================================================

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
  const [isCapturing, setIsCapturing] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const captureRef = useRef<HTMLDivElement>(null)

  const startCapture = useCallback(() => {
    setIsCapturing(true)
    setConflict(null)
  }, [])

  const stopCapture = useCallback(() => {
    setIsCapturing(false)
    setConflict(null)
  }, [])

  useEffect(() => {
    if (!isCapturing) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      // Escape cancels capture
      if (e.key === 'Escape') {
        stopCapture()
        return
      }

      // Ignore bare modifier presses
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
        setConflict(`Conflicts with: ${conflicts.map((c) => c.conflictingLabel).join(', ')}`)
        return
      }

      setIsCapturing(false)
      setConflict(null)
      void onRebind(entry.id, newBinding)
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isCapturing, entry.id, overrides, onRebind, stopCapture])

  // Close on outside click
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
    <div className="space-y-1">
      <div className="flex items-center justify-between py-2 group">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{entry.label}</span>
            {!isDefault && (
              <Badge variant="secondary" className="text-xs">
                Custom
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
        </div>

        <div ref={captureRef} className="flex items-center gap-2 ml-4">
          {isCapturing ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 px-2 py-1 rounded border border-primary bg-primary/5 text-sm text-primary animate-pulse">
                Press shortcut…
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={stopCapture}
                className="h-7 w-7 p-0"
                title="Cancel"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={startCapture}
                className="flex items-center gap-0.5 hover:opacity-70 transition-opacity"
                title="Click to rebind"
              >
                <KbdGroup>
                  {formatBinding(effectiveBinding)
                    .split(' ')
                    .map((part, i) => (
                      <Kbd key={i}>{part}</Kbd>
                    ))}
                </KbdGroup>
              </button>
              {!isDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onClearOverride(entry.id)}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Reset to default"
                >
                  <RotateCcw className="w-3 h-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {conflict && <p className="text-xs text-destructive pb-1">{conflict}</p>}
    </div>
  )
}

// ============================================================================
// Global Capture Row
// ============================================================================

const PLATFORM = window.navigator.platform.toLowerCase()
const IS_MACOS = PLATFORM.includes('mac')

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

function GlobalCaptureRow({
  binding,
  onSave
}: {
  binding: ShortcutBindingDTO | null
  onSave: (binding: ShortcutBindingDTO | null) => Promise<void>
}): React.JSX.Element {
  const [isCapturing, setIsCapturing] = useState(false)
  const [permissionStatus, setPermissionStatus] = useState<'unknown' | 'granted' | 'required'>(
    'unknown'
  )
  const captureRef = useRef<HTMLDivElement>(null)

  const checkAndRegister = useCallback(async () => {
    const result = await window.api.settings.registerGlobalCapture()
    if (result.permissionRequired) {
      setPermissionStatus('required')
    } else if (result.registered) {
      setPermissionStatus('granted')
    }
  }, [])

  useEffect(() => {
    void checkAndRegister()
  }, [checkAndRegister, binding])

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
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return
      const newBinding: ShortcutBindingDTO = {
        key: e.key,
        modifiers: {
          meta: e.metaKey || e.ctrlKey || undefined,
          shift: e.shiftKey || undefined,
          alt: e.altKey || undefined
        }
      }
      setIsCapturing(false)
      void onSave(newBinding)
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isCapturing, onSave, stopCapture])

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
    <div className="space-y-2">
      <div className="flex items-center justify-between py-2 group">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Global Capture</span>
            {permissionStatus === 'required' && (
              <Badge variant="destructive" className="text-xs gap-1">
                <AlertTriangle className="w-3 h-3" />
                Permission needed
              </Badge>
            )}
            {permissionStatus === 'granted' && binding && (
              <Badge variant="secondary" className="text-xs">
                Active
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Capture a note from anywhere, even when memry is in the background
          </p>
        </div>

        <div ref={captureRef} className="flex items-center gap-2 ml-4">
          {isCapturing ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 px-2 py-1 rounded border border-primary bg-primary/5 text-sm text-primary animate-pulse">
                Press shortcut…
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={stopCapture}
                className="h-7 w-7 p-0"
                title="Cancel"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {binding ? (
                <button
                  onClick={startCapture}
                  className="flex items-center gap-0.5 hover:opacity-70 transition-opacity"
                  title="Click to rebind"
                >
                  <KbdGroup>
                    {getGlobalCaptureParts(binding).map((part, i) => (
                      <Kbd key={i}>{part}</Kbd>
                    ))}
                  </KbdGroup>
                </button>
              ) : (
                <button
                  onClick={startCapture}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-dashed border-border"
                >
                  Click to set shortcut
                </button>
              )}
              {binding && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onSave(null)}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Clear shortcut"
                >
                  <X className="w-3 h-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {permissionStatus === 'required' && IS_MACOS && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Global shortcuts require Accessibility permission on macOS. Go to{' '}
            <strong>System Settings → Privacy &amp; Security → Accessibility</strong> and enable
            memry.
          </span>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Shortcuts Section
// ============================================================================

export function ShortcutsSettings() {
  const { settings, isLoading, updateSettings, resetToDefaults } = useKeyboardSettings()
  const [query, setQuery] = useState('')

  const overrides = settings.overrides
  const globalCapture = settings.globalCapture ?? null

  const handleGlobalCaptureSave = useCallback(
    async (binding: ShortcutBindingDTO | null): Promise<void> => {
      const success = await updateSettings({ globalCapture: binding })
      if (!success) toast.error('Failed to save global capture shortcut')
    },
    [updateSettings]
  )

  const handleRebind = useCallback(
    async (id: string, binding: ShortcutBinding): Promise<void> => {
      const entry = SHORTCUT_REGISTRY.find((e) => e.id === id)
      if (!entry) return

      // If new binding equals default, clear the override
      if (bindingsEqual(binding, entry.defaultBinding)) {
        const newOverrides = { ...overrides }
        delete newOverrides[id]
        const success = await updateSettings({ overrides: newOverrides })
        if (!success) toast.error('Failed to save shortcut')
        return
      }

      const success = await updateSettings({ overrides: { ...overrides, [id]: binding } })
      if (!success) toast.error('Failed to save shortcut')
    },
    [overrides, updateSettings]
  )

  const handleClearOverride = useCallback(
    async (id: string): Promise<void> => {
      const newOverrides = { ...overrides }
      delete newOverrides[id]
      const success = await updateSettings({ overrides: newOverrides })
      if (!success) toast.error('Failed to reset shortcut')
    },
    [overrides, updateSettings]
  )

  const handleResetAll = useCallback(async () => {
    const success = await resetToDefaults()
    if (success) toast.success('All shortcuts reset to defaults')
    else toast.error('Failed to reset shortcuts')
  }, [resetToDefaults])

  const lowerQuery = query.toLowerCase()
  const grouped = getGroupedShortcuts()

  const filteredGroups: [string, ShortcutEntry[]][] = CATEGORY_ORDER.flatMap((cat) => {
    const entries = grouped.get(cat) ?? []
    const filtered = query
      ? entries.filter(
          (e) =>
            e.label.toLowerCase().includes(lowerQuery) ||
            e.description.toLowerCase().includes(lowerQuery)
        )
      : entries
    return filtered.length > 0 ? [[cat, filtered] as [string, ShortcutEntry[]]] : []
  })

  const hasCustomBindings = Object.keys(overrides).length > 0

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Keyboard Shortcuts</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Keyboard Shortcuts</h3>
          <p className="text-sm text-muted-foreground">
            Click any shortcut to rebind it. Press Escape to cancel.
          </p>
        </div>
        {hasCustomBindings && (
          <Button variant="outline" size="sm" onClick={handleResetAll}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Reset All
          </Button>
        )}
      </div>

      <Separator />

      {/* Global Capture */}
      <GlobalCaptureRow binding={globalCapture} onSave={handleGlobalCaptureSave} />

      <Separator />

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search shortcuts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>

      {filteredGroups.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          No shortcuts match your search
        </p>
      )}

      {filteredGroups.map(([category, entries]) => (
        <div key={category} className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider py-1">
            {category}
          </h4>
          <div className="divide-y divide-border/50">
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
          </div>
        </div>
      ))}
    </div>
  )
}
