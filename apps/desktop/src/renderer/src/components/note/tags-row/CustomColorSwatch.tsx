import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { isHexColor } from './tag-colors'
import { useT } from '@memry/i18n/renderer'

interface CustomColorSwatchProps {
  value: string
  onChange: (hex: string) => void
  size?: 'sm' | 'md'
  className?: string
}

// A "custom color" swatch backed by the native OS color picker. The current
// value drives the swatch fill when it's already a custom hex; otherwise the
// swatch shows a rainbow conic gradient as the affordance.
export function CustomColorSwatch({
  value,
  onChange,
  size = 'md',
  className
}: CustomColorSwatchProps) {
  const { t } = useT('notes')
  const isCustom = isHexColor(value)
  const sizeClass = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'

  // While the native OS color picker is open it steals window focus; when it
  // closes Chromium returns focus to <body>. Radix layers (Dialog/Popover/Menu)
  // read that focusin as "focus outside" and auto-dismiss — closing the host
  // dialog mid-pick. While our picker is open, swallow focusin at the capture
  // phase (before Radix's bubble-phase document listener) so no ancestor layer
  // dismisses.
  // ponytail: one capture guard in the shared swatch beats wiring
  // onInteractOutside into every host surface (and handles nested menu layers).
  const guardingRef = useRef(false)
  useEffect(() => {
    const swallow = (e: FocusEvent) => {
      if (guardingRef.current) e.stopImmediatePropagation()
    }
    document.addEventListener('focusin', swallow, true)
    return () => document.removeEventListener('focusin', swallow, true)
  }, [])

  const armGuard = useCallback(() => {
    guardingRef.current = true
    // The picker closing refocuses our window; disarm one task later so the
    // focus-return focusin we need to swallow is still guarded.
    const disarm = () => {
      window.removeEventListener('focus', disarm)
      setTimeout(() => {
        guardingRef.current = false
      }, 0)
    }
    window.addEventListener('focus', disarm)
  }, [])

  // Commit only on the native `change` event — it fires once, when the OS color
  // panel is dismissed. React's onChange mirrors the live `input` event and fires
  // on every drag tick; committing there re-renders the host (e.g. the Settings
  // dialog closing via setColorTarget(null)), which unmounts this input and tears
  // the OS picker down on the first move. React's onChange stays local, tracking
  // the in-progress color so the controlled input follows the drag.
  const [draft, setDraft] = useState(isCustom ? value : '#888888')
  const [lastSyncedValue, setLastSyncedValue] = useState(value)
  if (value !== lastSyncedValue) {
    setLastSyncedValue(value)
    setDraft(isHexColor(value) ? value : '#888888')
  }

  const inputRef = useRef<HTMLInputElement>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const commit = () => onChangeRef.current(el.value)
    el.addEventListener('change', commit)
    return () => el.removeEventListener('change', commit)
  }, [])

  return (
    <label
      aria-label={t('tagsRow.customColor')}
      title={t('tagsRow.customColor')}
      className={cn(
        'relative inline-flex cursor-pointer items-center justify-center rounded-full',
        'transition-transform duration-150 hover:scale-110 focus-within:scale-110',
        sizeClass,
        isCustom && 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-background',
        className
      )}
      style={{
        background: isCustom
          ? value
          : 'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)'
      }}
    >
      <input
        ref={inputRef}
        type="color"
        value={draft}
        onClick={armGuard}
        onChange={(e) => setDraft(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  )
}
