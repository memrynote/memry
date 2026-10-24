import { Checkbox } from '@/components/ui/checkbox'

interface CheckboxEditorProps {
  value: boolean
  onChange: (value: boolean) => void
}

export function CheckboxEditor({ value, onChange }: CheckboxEditorProps) {
  return <Checkbox checked={value} onCheckedChange={(checked) => onChange(checked === true)} />
}
