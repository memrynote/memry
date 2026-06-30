export function EditableTitle({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <textarea
      aria-label="Title"
      value={value}
      disabled={disabled}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // ponytail: title is a single logical value; block literal newlines, let it wrap visually
        if (e.key === 'Enter') e.preventDefault()
      }}
      placeholder="Untitled"
      className="w-full resize-none bg-transparent font-sans text-[19px] font-medium leading-snug tracking-[-0.01em] text-foreground outline-none [field-sizing:content] placeholder:font-normal placeholder:text-text-tertiary"
    />
  )
}
