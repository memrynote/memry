import type { ComponentType, ReactNode } from 'react'

interface WidgetRowProps {
  className?: string
  children: ReactNode
  'data-testid'?: string
  'data-task-id'?: string
}

// Shared widget list row. No entrance animation: rows paint as soon as the data lands.
export function WidgetRow({
  className,
  children,
  ...dataProps
}: WidgetRowProps): React.JSX.Element {
  return (
    <li className={className} {...dataProps}>
      {children}
    </li>
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
