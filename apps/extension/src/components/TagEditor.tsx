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
    <div className="flex flex-wrap items-center gap-1.5 py-1.5">
      <span className="w-24 shrink-0 text-[13px] leading-4 text-text-tertiary">tags</span>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          disabled={disabled}
          onClick={() => onChange(tags.filter((x) => x !== tag))}
          className="inline-flex items-center gap-1 rounded-full bg-foreground/10 px-2.5 py-1 text-[12px]/4 font-medium text-foreground"
        >
          {tag}
          <span className="text-text-tertiary">×</span>
        </button>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
        }}
        onBlur={add}
        placeholder="+ add"
        className="w-16 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-tertiary"
      />
    </div>
  )
}
