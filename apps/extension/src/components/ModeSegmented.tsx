const MODES = [
  { id: 'article', label: 'Article', enabled: true },
  { id: 'selection', label: 'Selection', enabled: false },
  { id: 'shot', label: 'Shot', enabled: false }
] as const

export function ModeSegmented() {
  return (
    <div className="flex gap-1 rounded-md bg-surface p-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={!m.enabled}
          className={
            'flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors ' +
            (m.id === 'article' ? 'bg-background text-foreground shadow-sm' : 'text-text-tertiary')
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
