export function PrimaryButton({
  label,
  hint,
  onClick,
  disabled
}: {
  label: string
  hint?: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand/85 px-4 py-2.5 text-[13.5px] font-medium text-white shadow-sm transition-[transform,background-color,opacity] duration-[130ms] ease-[var(--ease-out)] hover:bg-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 active:scale-[0.985] disabled:opacity-50 disabled:active:scale-100"
    >
      <span>{label}</span>
      {hint && (
        <kbd className="rounded bg-white/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-white/80">
          {hint}
        </kbd>
      )}
    </button>
  )
}
