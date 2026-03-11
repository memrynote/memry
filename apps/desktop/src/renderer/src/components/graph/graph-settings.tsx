import { useState } from 'react'
import { Settings2, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { GraphSettings } from '@memry/contracts/graph-api'

interface GraphSettingsPanelProps {
  settings: GraphSettings
  updateSettings: (updates: Partial<GraphSettings>) => void
}

export function GraphSettingsPanel({
  settings,
  updateSettings
}: GraphSettingsPanelProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="absolute right-3 bottom-3 z-40">
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0 bg-popover/95 backdrop-blur-sm"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <Settings2 className="size-4 text-muted-foreground" />
      </Button>

      {isOpen && (
        <div className="absolute bottom-10 right-0 w-[240px] rounded-lg border border-border bg-popover/95 backdrop-blur-sm shadow-card animate-in fade-in-0 slide-in-from-bottom-2">
          <div className="p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">Graph Settings</span>
              <button
                onClick={() => setIsOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className="size-3.5" />
              </button>
            </div>

            <SettingSelect
              label="Layout"
              value={settings.layout}
              onValueChange={(v) => updateSettings({ layout: v as GraphSettings['layout'] })}
              options={[
                { value: 'forceatlas2', label: 'Force Atlas' },
                { value: 'circular', label: 'Circular' },
                { value: 'random', label: 'Random' }
              ]}
            />

            <SettingSelect
              label="Node sizing"
              value={settings.nodeSizing}
              onValueChange={(v) =>
                updateSettings({ nodeSizing: v as GraphSettings['nodeSizing'] })
              }
              options={[
                { value: 'uniform', label: 'Uniform' },
                { value: 'by-connections', label: 'By connections' },
                { value: 'by-word-count', label: 'By word count' }
              ]}
            />

            <SettingSlider
              label="Repulsion"
              value={settings.repulsionStrength}
              min={1}
              max={100}
              onChange={(v) => updateSettings({ repulsionStrength: v })}
            />

            <SettingSlider
              label="Link distance"
              value={settings.linkDistance}
              min={10}
              max={200}
              onChange={(v) => updateSettings({ linkDistance: v })}
            />

            <SettingSwitch
              label="Show labels"
              checked={settings.showLabels}
              onCheckedChange={(v) => updateSettings({ showLabels: v })}
            />

            <SettingSwitch
              label="Edge labels"
              checked={settings.showEdgeLabels}
              onCheckedChange={(v) => updateSettings({ showEdgeLabels: v })}
            />

            <SettingSwitch
              label="Animate layout"
              checked={settings.animateLayout}
              onCheckedChange={(v) => updateSettings({ animateLayout: v })}
            />

            <SettingSwitch
              label="Tag co-occurrence edges"
              checked={settings.showTagEdges}
              onCheckedChange={(v) => updateSettings({ showTagEdges: v })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function SettingSelect({
  label,
  value,
  onValueChange,
  options
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SettingSlider({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">
          {label}
        </Label>
        <span className="text-[10px] text-muted-foreground tabular-nums">{value}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={([v]) => onChange(v)}
        className="py-1"
      />
    </div>
  )
}

function SettingSwitch({
  label,
  checked,
  onCheckedChange
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
