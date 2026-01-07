import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface Toast {
  id: string
  message: string
  type?: 'success' | 'error' | 'info'
  onUndo?: () => void
}

interface ToastItemProps {
  toast: Toast
  onDismiss: (id: string) => void
}

const ToastItem = ({ toast, onDismiss }: ToastItemProps): React.JSX.Element => {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setIsVisible(true))

    // Auto dismiss after 4 seconds
    const timer = setTimeout(() => {
      setIsVisible(false)
      setTimeout(() => onDismiss(toast.id), 150)
    }, 4000)

    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const handleUndo = (): void => {
    if (toast.onUndo) {
      toast.onUndo()
    }
    setIsVisible(false)
    setTimeout(() => onDismiss(toast.id), 150)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg',
        'transition-[transform,opacity] duration-[var(--duration-normal)] ease-[var(--ease-out)]',
        'bg-foreground text-background',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      )}
      role="alert"
      aria-live="polite"
    >
      {/* Success icon */}
      <div className="size-5 rounded-full bg-green-500 flex items-center justify-center shrink-0">
        <Check className="size-3 text-white" aria-hidden="true" />
      </div>

      {/* Message */}
      <span className="text-sm font-medium flex-1">{toast.message}</span>

      {/* Undo button with hover scale effect */}
      {toast.onUndo && (
        <button
          type="button"
          onClick={handleUndo}
          className={cn(
            'text-sm font-medium text-background/70 underline underline-offset-2',
            'transition-[color,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
            'hover:text-background hover:scale-105 active:scale-95'
          )}
        >
          Undo
        </button>
      )}

      {/* Close button */}
      <button
        type="button"
        onClick={() => {
          setIsVisible(false)
          setTimeout(() => onDismiss(toast.id), 150)
        }}
        className={cn(
          'text-background/50 p-0.5',
          'transition-[color,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
          'hover:text-background hover:scale-110 active:scale-95'
        )}
        aria-label="Dismiss notification"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

interface ToastContainerProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

const ToastContainer = ({ toasts, onDismiss }: ToastContainerProps): React.JSX.Element => {
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  )
}

export { ToastItem, ToastContainer }
