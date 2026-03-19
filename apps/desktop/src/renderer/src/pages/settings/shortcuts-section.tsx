import { useState, useCallback, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Badge } from '@/components/ui/badge'
import { Search, RotateCcw, X } from '@/lib/icons'
import { useKeyboardSettings } from '@/hooks/use-keyboard-settings'
import { toast } from 'sonner'
import type { ShortcutBinding } from '@memry/contracts/settings-schemas'
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
// Shortcuts Section
// ============================================================================

export function ShortcutsSettings() {
  const { settings, isLoading, updateSettings, resetToDefaults } = useKeyboardSettings()
  const [query, setQuery] = useState('')

  const overrides = settings.overrides

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
