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
    <input
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Untitled"
      className="w-full bg-transparent font-serif text-[19px] font-medium leading-snug tracking-[-0.01em] text-foreground outline-none placeholder:text-text-tertiary placeholder:font-normal"
    />
  )
}
