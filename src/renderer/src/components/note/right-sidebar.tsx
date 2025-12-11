import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Bot, Link2, ChevronRight, X } from 'lucide-react'
import { AIAgentTab } from './ai-agent'
import { RelatedNotesTab } from './related-notes'

type TabType = 'ai' | 'related'

interface RightSidebarProps {
  isOpen: boolean
  onToggle: () => void
  defaultTab?: TabType
  className?: string
}

export function RightSidebar({
  isOpen,
  onToggle,
  defaultTab = 'ai',
  className
}: RightSidebarProps) {
  const [activeTab, setActiveTab] = useState<TabType>(defaultTab)

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 lg:hidden"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          'fixed lg:relative right-0 top-0 h-full w-80 bg-white',
          'border-l border-stone-200/60 shadow-sm',
          'transition-transform duration-200 ease-out z-50',
          'flex flex-col',
          isOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
          !isOpen && 'lg:w-0 lg:border-0 lg:shadow-none',
          className
        )}
      >
        {/* Header with close button (mobile) */}
        <div className="flex items-center justify-between px-4 py-3 lg:hidden border-b border-stone-200/60">
          <h2 className="text-sm font-medium text-stone-900">Panel</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggle}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-stone-200/60" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'ai'}
            aria-controls="ai-panel"
            onClick={() => setActiveTab('ai')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3',
              'text-sm font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-inset',
              activeTab === 'ai'
                ? 'text-stone-900 border-b-2 border-stone-900'
                : 'text-stone-500 hover:text-stone-700'
            )}
          >
            <Bot className="h-4 w-4" />
            <span>AI Agent</span>
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'related'}
            aria-controls="related-panel"
            onClick={() => setActiveTab('related')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3',
              'text-sm font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-inset',
              activeTab === 'related'
                ? 'text-stone-900 border-b-2 border-stone-900'
                : 'text-stone-500 hover:text-stone-700'
            )}
          >
            <Link2 className="h-4 w-4" />
            <span>Related</span>
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'ai' && (
            <div
              id="ai-panel"
              role="tabpanel"
              aria-labelledby="ai-tab"
              className="h-full"
            >
              <AIAgentTab />
            </div>
          )}

          {activeTab === 'related' && (
            <div
              id="related-panel"
              role="tabpanel"
              aria-labelledby="related-tab"
              className="h-full"
            >
              <RelatedNotesTab />
            </div>
          )}
        </div>
      </div>

      {/* Collapse/expand toggle button (desktop only) */}
      {!isOpen && (
        <button
          onClick={onToggle}
          className={cn(
            'hidden lg:flex items-center justify-center',
            'fixed right-0 top-1/2 -translate-y-1/2',
            'w-6 h-16 bg-white border border-r-0 border-stone-200/60',
            'rounded-l-md shadow-sm',
            'hover:bg-stone-50 transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400'
          )}
          aria-label="Open sidebar"
        >
          <ChevronRight className="h-4 w-4 text-stone-500 -ml-0.5" />
        </button>
      )}
    </>
  )
}
