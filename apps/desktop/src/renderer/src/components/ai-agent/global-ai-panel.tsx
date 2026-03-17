/**
 * Global AI Agent Panel
 * An inline panel for the AI agent that pushes content when open
 * Animated similar to the left sidebar
 */

import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useAIAgent } from '@/contexts/ai-agent-context'
import { AIAgentTab } from '@/components/note/ai-agent'

interface GlobalAIPanelProps {
  className?: string
}

export function GlobalAIPanel({ className }: GlobalAIPanelProps) {
  const { isOpen, close } = useAIAgent()

  return (
    <>
      {/* Gap element that animates width - pushes content */}
      <div
        data-slot="ai-panel-gap"
        className={cn(
          'relative bg-transparent transition-[width] duration-200 ease-linear',
          isOpen ? 'w-80' : 'w-0'
        )}
      />

      {/* Panel container - fixed position below header */}
      <div
        data-slot="ai-panel-container"
        className={cn(
          'fixed top-10 bottom-0 right-0 z-10',
          'transition-[width] duration-200 ease-linear',
          'flex flex-col bg-sidebar border-l border-sidebar-border',
          isOpen ? 'w-80' : 'w-0',
          className
        )}
      >
        {/* Inner content wrapper */}
        <div
          data-slot="ai-panel-inner"
          className={cn(
            'flex h-full w-80 flex-col',
            'transition-opacity duration-200',
            isOpen ? 'opacity-100' : 'opacity-0'
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-sidebar-border shrink-0">
            <h2 className="text-sm font-medium text-sidebar-primary">AI Agent</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={close}
              aria-label="Close AI Agent"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* AI Agent Content */}
          <div className="flex-1 overflow-hidden">
            <AIAgentTab />
          </div>
        </div>
      </div>
    </>
  )
}

export default GlobalAIPanel
