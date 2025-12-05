import { motion } from "framer-motion"
import { X, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"

// ============================================================================
// TYPES
// ============================================================================

interface OverdueClearedBannerProps {
  /** Callback when banner is dismissed */
  onDismiss: () => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// OVERDUE CLEARED BANNER
// ============================================================================

/**
 * A celebratory banner shown when all overdue tasks are cleared.
 * Designed to appear briefly and then auto-dismiss or be manually closed.
 *
 * Use with AnimatePresence for enter/exit animations:
 *
 * @example
 * ```tsx
 * <AnimatePresence>
 *   {showCelebration && (
 *     <OverdueClearedBanner onDismiss={handleDismiss} />
 *   )}
 * </AnimatePresence>
 * ```
 */
export const OverdueClearedBanner = ({
  onDismiss,
  className,
}: OverdueClearedBannerProps): React.JSX.Element => {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
      animate={{ opacity: 1, height: "auto", marginBottom: 16 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn(
        "overflow-hidden rounded-lg",
        "bg-emerald-50 dark:bg-emerald-950/30",
        "border border-emerald-200 dark:border-emerald-800/50",
        className
      )}
    >
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          {/* Content */}
          <div className="flex items-center gap-2.5">
            {/* Sparkle icon with subtle animation */}
            <motion.span
              initial={{ rotate: -15, scale: 0.8 }}
              animate={{ rotate: 0, scale: 1 }}
              transition={{ duration: 0.4, ease: "easeOut", delay: 0.1 }}
              className="shrink-0"
            >
              <Sparkles
                className="size-5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            </motion.span>

            {/* Message */}
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
              All caught up! No overdue tasks.
            </span>
          </div>

          {/* Dismiss button */}
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "shrink-0 p-1 rounded-md",
              "text-emerald-600 dark:text-emerald-400",
              "hover:bg-emerald-100 dark:hover:bg-emerald-900/50",
              "transition-colors",
              "focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            )}
            aria-label="Dismiss celebration banner"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export default OverdueClearedBanner
