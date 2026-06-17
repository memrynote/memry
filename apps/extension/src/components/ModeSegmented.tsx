import type { CaptureMode } from '@/lib/messages'

const MODES: { id: CaptureMode; label: string }[] = [
  { id: 'article', label: 'Article' },
  { id: 'selection', label: 'Selection' },
  { id: 'screenshot', label: 'Shot' }
]

export function ModeSegmented({
  mode,
  disabled,
  onSelect
}: {
  mode: CaptureMode
  disabled: boolean
  onSelect: (mode: CaptureMode) => void
}) {
  return (
    <div className="flex gap-1 rounded-md bg-surface p-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(m.id)}
          className={
            'flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors disabled:opacity-50 ' +
            (m.id === mode ? 'bg-background text-foreground shadow-sm' : 'text-text-tertiary')
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
