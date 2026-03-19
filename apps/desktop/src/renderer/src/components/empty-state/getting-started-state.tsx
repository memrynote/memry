import { Inbox } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { CaptureMethodsGrid } from '@/components/empty-state/capture-methods-grid'
import { cn } from '@/lib/utils'

interface GettingStartedStateProps {
  onInstallExtension?: () => void
}

/**
 * Getting Started state - shown for new users or when no captures exist.
 * Displays onboarding guidance with capture methods and CTA.
 */
const GettingStartedState = ({
  onInstallExtension
}: GettingStartedStateProps): React.JSX.Element => {
  const handleInstallClick = (): void => {
    if (onInstallExtension) {
      onInstallExtension()
    } else {
      // Default behavior: open extension store (placeholder)
      window.open('https://chrome.google.com/webstore', '_blank')
    }
  }

  return (
    <div className="flex flex-col items-center text-center max-w-md space-y-8">
      {/* Inbox Icon in box */}
      <div
        className={cn(
          'flex items-center justify-center',
          'size-20 rounded-xl',
          'border border-border bg-muted/30',
          'empty-state-entrance stagger-delay-1',
          'motion-reduce:animate-none'
        )}
        aria-hidden="true"
      >
        <Inbox className="size-10 text-muted-foreground" strokeWidth={1.5} />
      </div>

      {/* Title */}
      <h2
        className={cn(
          'text-2xl font-medium text-foreground',
          'empty-state-entrance stagger-delay-2',
          'motion-reduce:animate-none'
        )}
      >
        Your inbox is empty
      </h2>

      {/* Description */}
      <p
        className={cn(
          'text-sm text-muted-foreground leading-relaxed',
          'empty-state-entrance stagger-delay-3',
          'motion-reduce:animate-none'
        )}
      >
        Capture links, notes, images, and voice memos to process them later
      </p>

      {/* Capture Methods Grid */}
      <CaptureMethodsGrid />

      {/* Primary CTA */}
      <Button
        onClick={handleInstallClick}
        size="lg"
        className={cn('empty-state-entrance stagger-delay-5', 'motion-reduce:animate-none')}
      >
        Install browser extension
      </Button>
    </div>
  )
}

export { GettingStartedState }
