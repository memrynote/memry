interface PickerSectionProps {
  label?: string
  children: React.ReactNode
}

export function PickerSection({ label, children }: PickerSectionProps): React.JSX.Element {
  return (
    <div data-slot="picker-section">
      {label && (
        <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {label}
        </div>
      )}
      {children}
    </div>
  )
}
