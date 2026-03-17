import { Clock, Calendar } from '@/lib/icons'
import { quickSnoozePresets, type SnoozePreset } from '@/components/snooze/snooze-presets'

interface TriageSnoozPickerProps {
  onSelect: (snoozeUntil: string) => void
  onCancel: () => void
}

export function TriageSnoozePicker({
  onSelect,
  onCancel
}: TriageSnoozPickerProps): React.JSX.Element {
  const presets = quickSnoozePresets

  const handlePresetClick = (preset: SnoozePreset): void => {
    onSelect(preset.getTime().toISOString())
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        <Clock className="size-3.5" />
        <span>Snooze until…</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => handlePresetClick(preset)}
            className="border-border bg-background hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            <Calendar className="size-3" />
            {preset.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
