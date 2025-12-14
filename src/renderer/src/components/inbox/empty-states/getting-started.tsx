/**
 * Getting Started Empty State
 *
 * Shown when the user has never captured any items.
 * Guides them on how to use the inbox with capture methods.
 */
import { useEffect, useState } from 'react'
import {
  Inbox,
  Clipboard,
  Upload,
  Globe,
  Mic,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TypeIcon } from '../type-badge'

// =============================================================================
// TYPES
// =============================================================================

export interface GettingStartedProps {
  onCapture?: () => void
  className?: string
}

// =============================================================================
// CAPTURE METHOD
// =============================================================================

interface CaptureMethod {
  icon: React.ComponentType<{ className?: string }>
  label: string
  shortcut?: string
  description: string
}

const captureMethods: CaptureMethod[] = [
  {
    icon: Clipboard,
    label: 'Paste anything',
    shortcut: '⌘V',
    description: 'Links, text, images',
  },
  {
    icon: Upload,
    label: 'Drag & drop',
    shortcut: 'or click',
    description: 'Files and images',
  },
  {
    icon: Globe,
    label: 'Browser extension',
    shortcut: 'Install',
    description: 'Save from any page',
  },
  {
    icon: Mic,
    label: 'Voice capture',
    shortcut: '⌘⇧R',
    description: 'Record a thought',
  },
]

// =============================================================================
// GHOST PREVIEW ITEMS
// =============================================================================

interface GhostItem {
  type: 'link' | 'note' | 'image'
  title: string
}

const ghostItems: GhostItem[] = [
  { type: 'link', title: 'Article title here...' },
  { type: 'note', title: 'Note preview text...' },
  { type: 'image', title: 'Screenshot.png' },
]

// =============================================================================
// COMPONENT
// =============================================================================

export function GettingStarted({
  onCapture,
  className,
}: GettingStartedProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false)

  // Animate in on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={cn(
        'flex min-h-[500px] flex-col items-center justify-center px-6 py-12',
        'transition-all duration-500 ease-out',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
        className
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          'relative flex size-20 items-center justify-center rounded-2xl',
          'bg-gradient-to-br from-primary/10 to-primary/5',
          'border border-primary/10',
          'shadow-lg shadow-primary/5'
        )}
        style={{
          animationDelay: '100ms',
        }}
      >
        <Inbox className="size-10 text-primary" />
        {/* Subtle glow */}
        <div className="absolute inset-0 rounded-2xl bg-primary/5 blur-xl" />
      </div>

      {/* Headline */}
      <h2
        className={cn(
          'mt-6 text-2xl font-semibold tracking-tight text-foreground',
          'transition-all duration-500 delay-100',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        Your inbox is ready
      </h2>

      {/* Subtext */}
      <p
        className={cn(
          'mt-2 max-w-md text-center text-muted-foreground',
          'transition-all duration-500 delay-150',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        Capture ideas, links, and files from anywhere.
        They'll appear here until you're ready to organize.
      </p>

      {/* Capture Methods */}
      <div
        className={cn(
          'mt-8 w-full max-w-sm rounded-xl border border-border/60 bg-card/50 p-1',
          'transition-all duration-500 delay-200',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        {captureMethods.map((method, index) => {
          const Icon = method.icon
          return (
            <div
              key={method.label}
              className={cn(
                'flex items-center gap-3 rounded-lg px-4 py-3',
                'transition-colors duration-150',
                'hover:bg-accent/50'
              )}
              style={{
                animationDelay: `${250 + index * 50}ms`,
              }}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/80">
                <Icon className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {method.label}
                  </span>
                  {method.shortcut && (
                    <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                      {method.shortcut}
                    </kbd>
                  )}
                </div>
                <span className="text-xs text-muted-foreground/70">
                  {method.description}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* CTA Button */}
      <Button
        onClick={onCapture}
        className={cn(
          'mt-6 gap-2',
          'transition-all duration-500 delay-300',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        Try Pasting Something
        <ArrowRight className="size-4" />
      </Button>

      {/* Ghost Preview */}
      <div
        className={cn(
          'mt-10 w-full max-w-md rounded-xl border border-dashed border-border/50 bg-muted/20 p-4',
          'transition-all duration-500 delay-400',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        <p className="mb-3 text-xs font-medium text-muted-foreground/60">
          Preview: What items will look like
        </p>
        <div className="space-y-2">
          {ghostItems.map((item) => (
            <div
              key={item.type}
              className="flex items-center gap-2.5 rounded-md bg-background/50 px-3 py-2 opacity-50"
            >
              <TypeIcon type={item.type} size="sm" />
              <span className="text-sm text-muted-foreground">{item.title}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
