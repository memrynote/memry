import { StickyEdgeTab } from './components/sticky/sticky-edge-tab'
import { useUserAccentColor } from './hooks/use-user-accent-color'

/**
 * The edge tab window's tree below the providers every window shares
 * (main.tsx). Loaded by main.tsx only for `#/sticky-tab`.
 */
export function StickyTabRoot(): React.JSX.Element {
  useUserAccentColor()
  return <StickyEdgeTab />
}
