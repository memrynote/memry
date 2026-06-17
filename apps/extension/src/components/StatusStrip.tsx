import type { Phase } from '@/lib/popup-state'

const LABEL: Partial<Record<Phase, string>> = {
  'app-closed': "Memry isn't running",
  'needs-pairing': 'Not paired',
  ready: 'Connected',
  pairing: 'Pairing…',
  saving: 'Saving…',
  saved: 'Saved'
}

export function StatusStrip({ phase }: { phase: Phase }) {
  const connected = phase === 'ready' || phase === 'saving' || phase === 'saved'
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <span className="text-[13px] font-semibold text-foreground">Memry</span>
      <span className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: connected ? 'var(--accent-green)' : 'var(--text-tertiary)' }}
        />
        {LABEL[phase] ?? ''}
      </span>
    </div>
  )
}
