import { useHintModeContext } from '@/contexts/hint-mode'
import { cn } from '@/lib/utils'

export const HintIndicator = (): React.JSX.Element | null => {
  const { state } = useHintModeContext()

  if (!state.isActive) return null

  return (
    <div
      className={cn(
        'fixed bottom-4 left-1/2 -translate-x-1/2 z-50',
        'bg-amber-500 text-black',
        'px-4 py-2 rounded-md shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2 duration-200'
      )}
    >
      <div className="flex items-center gap-2 text-sm font-mono font-bold">
        <span>HINT</span>
        {state.typedChars && (
          <kbd className="px-1.5 py-0.5 bg-black/20 rounded text-xs">{state.typedChars}</kbd>
        )}
      </div>
    </div>
  )
}
