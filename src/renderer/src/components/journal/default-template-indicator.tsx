/**
 * DefaultTemplateIndicator Component
 *
 * A subtle indicator shown when a default journal template is set.
 * Allows users to change the template or start with a blank entry.
 *
 * @module components/journal/default-template-indicator
 */

import { useCallback, useState, useEffect } from 'react'
import { FileText, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DefaultTemplateIndicatorProps {
  /** Name of the current default template */
  templateName: string
  /** Icon of the template (emoji or null) */
  templateIcon?: string | null
  /** Whether the entry is being created */
  isCreating?: boolean
  /** Callback when user wants to change template */
  onChangeTemplate: () => void
  /** Callback when user wants to start blank */
  onStartBlank: () => void
  /** Optional className */
  className?: string
}

/**
 * Displays a subtle indicator when a default template is being used.
 * Auto-fades after user starts typing or after a timeout.
 */
export function DefaultTemplateIndicator({
  templateName,
  templateIcon,
  isCreating = false,
  onChangeTemplate,
  onStartBlank,
  className
}: DefaultTemplateIndicatorProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(true)
  const [isFading, setIsFading] = useState(false)

  // Auto-hide after 5 seconds if still visible
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsFading(true)
      // After fade animation, hide completely
      setTimeout(() => setIsVisible(false), 300)
    }, 5000)

    return () => clearTimeout(timer)
  }, [])

  // Handle dismiss
  const handleDismiss = useCallback(() => {
    setIsFading(true)
    setTimeout(() => setIsVisible(false), 300)
  }, [])

  if (!isVisible) {
    return <></>
  }

  return (
    <div
      className={cn(
        'relative mb-4 transition-all duration-300',
        isFading && 'opacity-0 translate-y-[-8px]',
        className
      )}
    >
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-3 rounded-lg',
          'border border-dashed',
          'border-amber-300/60 dark:border-amber-700/50',
          'bg-gradient-to-r from-amber-50/60 to-orange-50/40',
          'dark:from-amber-950/30 dark:to-orange-950/20',
          'transition-colors duration-200'
        )}
      >
        {/* Template icon */}
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/50 dark:to-orange-900/40 flex items-center justify-center border border-amber-200/50 dark:border-amber-800/30 shadow-sm">
          {templateIcon ? (
            <span className="text-base">{templateIcon}</span>
          ) : (
            <FileText className="w-4 h-4 text-amber-700 dark:text-amber-400" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Using "{templateName}"
            </span>
            {isCreating && (
              <RefreshCw className="w-3 h-3 text-amber-600 dark:text-amber-400 animate-spin" />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <button
              onClick={onChangeTemplate}
              className={cn(
                'text-xs font-medium',
                'text-amber-600/80 dark:text-amber-400/80',
                'hover:text-amber-700 dark:hover:text-amber-300',
                'underline underline-offset-2 decoration-amber-400/40',
                'hover:decoration-amber-500/60',
                'transition-colors duration-150'
              )}
            >
              Change template
            </button>
            <span className="text-amber-400/60 dark:text-amber-600/60">·</span>
            <button
              onClick={onStartBlank}
              className={cn(
                'text-xs font-medium',
                'text-amber-600/70 dark:text-amber-400/70',
                'hover:text-amber-700 dark:hover:text-amber-300',
                'transition-colors duration-150'
              )}
            >
              Start blank instead
            </button>
          </div>
        </div>

        {/* Dismiss button */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'flex-shrink-0 w-6 h-6',
            'text-amber-500/60 hover:text-amber-700',
            'dark:text-amber-500/50 dark:hover:text-amber-300',
            'hover:bg-amber-100/50 dark:hover:bg-amber-900/30'
          )}
          onClick={handleDismiss}
          aria-label="Dismiss indicator"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}

export default DefaultTemplateIndicator
