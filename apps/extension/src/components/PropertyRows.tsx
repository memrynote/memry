import type { ArticleCapture } from '@memry/article-extract'

type Props = ArticleCapture['properties']

function Row({
  label,
  value,
  onChange,
  disabled
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center py-1.5">
      <span className="w-24 shrink-0 truncate text-[13px] leading-4 text-text-tertiary">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
      />
    </div>
  )
}

export function PropertyRows({
  properties,
  onChange,
  disabled
}: {
  properties: Props
  onChange: (next: Props) => void
  disabled?: boolean
}) {
  const set = (patch: Partial<Props>) => onChange({ ...properties, ...patch })
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-text-tertiary">
        Properties
      </div>
      <Row
        label="source"
        value={properties.source}
        disabled={disabled}
        onChange={(v) => set({ source: v })}
      />
      <Row
        label="author"
        value={(properties.author ?? []).join(', ')}
        disabled={disabled}
        onChange={(v) =>
          set({
            author: v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          })
        }
      />
      <Row
        label="published"
        value={properties.published ?? ''}
        disabled={disabled}
        onChange={(v) => set({ published: v })}
      />
      <Row
        label="created"
        value={properties.created}
        disabled={disabled}
        onChange={(v) => set({ created: v })}
      />
      <Row
        label="description"
        value={properties.description ?? ''}
        disabled={disabled}
        onChange={(v) => set({ description: v })}
      />
    </div>
  )
}
