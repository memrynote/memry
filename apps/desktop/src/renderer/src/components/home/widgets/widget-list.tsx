import type { ComponentType, ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'

interface WidgetRowProps {
  index: number
  className?: string
  children: ReactNode
  'data-testid'?: string
  'data-task-id'?: string
}

// Shared entrance for widget list rows: when data replaces the skeleton the rows rise in with a
// short stagger instead of a hard cut. Critically damped — a list entrance carries no momentum,
// so no overshoot. Collapses to a plain fade under reduced motion.
export function WidgetRow({
  index,
  className,
  children,
  ...dataProps
}: WidgetRowProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  return (
    <motion.li
      className={className}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{
        type: 'spring',
        bounce: 0,
        duration: 0.35,
        delay: Math.min(index * 0.025, 0.2)
      }}
      {...dataProps}
    >
      {children}
    </motion.li>
  )
}

interface WidgetEmptyStateProps {
  icon: ComponentType<{ className?: string }>
  label: string
}

// Shared empty state: centered icon + label so an empty widget reads as a calm, deliberate
// state instead of a stray line of text.
export function WidgetEmptyState({ icon: Icon, label }: WidgetEmptyStateProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-20 flex-col items-center justify-center gap-1.5 py-3 text-center">
      <span aria-hidden="true">
        <Icon className="size-5 text-muted-foreground/40" />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
