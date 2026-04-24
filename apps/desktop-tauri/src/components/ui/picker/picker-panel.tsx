import { usePickerContext } from './types'

interface PickerPanelProps {
  id: string | null
  children: React.ReactNode
}

export function PickerPanel({ id, children }: PickerPanelProps): React.JSX.Element | null {
  const { activePanel } = usePickerContext()
  if (activePanel !== id) return null
  return <>{children}</>
}
