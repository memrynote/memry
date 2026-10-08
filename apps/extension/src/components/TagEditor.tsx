import { useId, useState } from 'react'

const MAX_SUGGESTIONS = 6

// Prefix matches first, then substring matches; tags already on the clip are
// skipped. Case-insensitive, matching how the vault treats tag identity.
export function matchTags(query: string, suggestions: string[], taken: string[]): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const takenSet = new Set(taken.map((t) => t.toLowerCase()))
  const prefix: string[] = []
  const inner: string[] = []
  for (const s of suggestions) {
    const lower = s.toLowerCase()
    if (takenSet.has(lower)) continue
    if (lower.startsWith(q)) prefix.push(s)
    else if (lower.includes(q)) inner.push(s)
  }
  return [...prefix, ...inner].slice(0, MAX_SUGGESTIONS)
}

export function TagEditor({
  tags,
  onChange,
  disabled,
  suggestions = []
}: {
  tags: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  suggestions?: string[]
}) {
  const [draft, setDraft] = useState('')
  // -1 = nothing highlighted, so Enter keeps adding the typed text as a new tag.
  const [active, setActive] = useState(-1)
  const listId = useId()
  const matches = matchTags(draft, suggestions, tags)
  const commit = (value: string) => {
    const t = value.trim()
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...tags, t])
    setDraft('')
    setActive(-1)
  }
  const add = () => commit(draft)
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
      <span className="relative">
        <input
          aria-label="Add tag"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value)
            setActive(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && matches.length > 0) {
              e.preventDefault()
              setActive((i) => (i + 1) % matches.length)
            } else if (e.key === 'ArrowUp' && matches.length > 0) {
              e.preventDefault()
              setActive((i) => (i <= 0 ? matches.length - 1 : i - 1))
            } else if (e.key === 'Escape' && matches.length > 0) {
              // Close the list without closing the popup.
              e.preventDefault()
              e.stopPropagation()
              setDraft('')
              setActive(-1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit(active >= 0 ? matches[active] : draft)
            }
          }}
          onBlur={add}
          placeholder="Add tag…"
          className="w-20 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-tertiary"
        />
        {matches.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="absolute start-0 top-full z-10 mt-1 max-h-40 min-w-36 overflow-y-auto rounded-md border border-border bg-surface-strong py-1 shadow-md"
          >
            {matches.map((m, i) => (
              <li
                key={m}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown + preventDefault keeps focus in the input, so its
                // onBlur does not commit the half-typed draft first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(m)
                }}
                onMouseEnter={() => setActive(i)}
                className={
                  'cursor-pointer truncate px-2.5 py-1 text-[12px] text-text-secondary ' +
                  (i === active ? 'bg-surface-active text-foreground' : '')
                }
              >
                {m}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  )
}
