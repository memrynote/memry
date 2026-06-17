import { useState } from 'react'

export function TagEditor({
  tags,
  onChange,
  disabled
}: {
  tags: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="size-3.5 shrink-0 text-text-tertiary"
        aria-hidden
      >
        <path d="M3 7v5l8 8 6-6-8-8H4a1 1 0 0 0-1 1Z" strokeLinejoin="round" />
        <circle cx="7" cy="11" r="1" fill="currentColor" stroke="none" />
      </svg>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          disabled={disabled}
          onClick={() => onChange(tags.filter((x) => x !== tag))}
          className="group inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:border-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:opacity-60"
        >
          {tag}
          <span className="text-text-tertiary transition-colors group-hover:text-foreground">
            ×
          </span>
        </button>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        placeholder="Add tag…"
        className="w-20 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-tertiary"
      />
    </div>
  )
}
