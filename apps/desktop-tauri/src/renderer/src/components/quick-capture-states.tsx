import { useEffect } from 'react'
import { Check, Copy, X } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

interface CaptureSuccessProps {
  onAutoClose: () => void
}

export function CaptureSuccess({ onAutoClose }: CaptureSuccessProps): React.JSX.Element {
  const { t: tPhaseF } = useT('inbox')
  useEffect(() => {
    const timer = setTimeout(onAutoClose, 1000)
    return () => clearTimeout(timer)
  }, [onAutoClose])

  return (
    <div className="flex items-center gap-2.5 px-4 py-3.5">
      <div className="flex size-5 items-center justify-center rounded-full bg-green-500/15">
        <Check className="size-3 text-green-500" />
      </div>
      <span className="text-sm font-medium text-foreground">
        {tPhaseF('phaseF.componentsQuickCaptureStates.captured')}
      </span>
    </div>
  )
}

interface CaptureErrorProps {
  message: string
  onDismiss: () => void
}

export function CaptureError({ message, onDismiss }: CaptureErrorProps): React.JSX.Element {
  const { t: tPhaseF } = useT('inbox')
  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <span className="flex-1 text-xs text-destructive truncate">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
        aria-label={tPhaseF('phaseF.componentsQuickCaptureStates.dismissError')}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

interface CaptureDuplicateProps {
  title: string
  createdAt: string
  onForce: () => void
  onClose: () => void
}

export function CaptureDuplicate({
  title,
  createdAt,
  onForce,
  onClose
}: CaptureDuplicateProps): React.JSX.Element {
  const { t: tPhaseF } = useT('inbox')
  const dateStr = new Date(createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
  const displayTitle = title.length > 60 ? `${title.slice(0, 60)}...` : title

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Copy className="size-4 text-accent-orange" />
        <span className="text-sm font-medium text-foreground">
          {tPhaseF('phaseF.componentsQuickCaptureStates.alreadyCaptured')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground truncate">
        {tPhaseF('phaseF.componentsQuickCaptureStates.duplicateMeta', {
          title: displayTitle,
          date: dateStr
        })}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onForce}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {tPhaseF('phaseF.componentsQuickCaptureStates.captureAnyway')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-accent-orange px-2.5 py-1 text-xs font-medium text-white transition-colors hover:opacity-90"
        >
          {tPhaseF('phaseF.componentsQuickCaptureStates.close')}
        </button>
      </div>
    </div>
  )
}
