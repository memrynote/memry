import { useId, useRef } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

export type InboxView = 'inbox' | 'archived' | 'insights'

export interface InboxSegmentControlProps {
  value: InboxView
  onChange: (view: InboxView) => void
  className?: string
}

const VIEWS: InboxView[] = ['inbox', 'archived', 'insights']

export function InboxSegmentControl({
  value,
  onChange,
  className
}: InboxSegmentControlProps): React.JSX.Element {
  const { t } = useT('inbox')
  const prefersReducedMotion = useReducedMotion()
  const layoutGroupId = useId()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const tabs = [
    { id: 'inbox', label: t('view.tabs.inbox') },
    { id: 'archived', label: t('view.tabs.archived') },
    { id: 'insights', label: t('view.tabs.insights') }
  ] as const

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (VIEWS.indexOf(value) + delta + VIEWS.length) % VIEWS.length
    onChange(VIEWS[nextIndex])
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <LayoutGroup id={layoutGroupId}>
      <div
        role="tablist"
        aria-label={t('view.tabs.ariaLabel')}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex items-center shrink-0 rounded-[5px] overflow-clip border border-border',
          className
        )}
      >
        {tabs.map((tab, index) => {
          const isActive = value === tab.id
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={cn(
                'relative flex items-center py-1 px-2.5 transition-colors duration-150',
                'focus-visible:outline-none active:scale-[0.97]',
                isActive
                  ? 'text-background font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-active/50'
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="segment-pill"
                  aria-hidden="true"
                  transition={
                    prefersReducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', bounce: 0, duration: 0.35 }
                  }
                  className="absolute inset-0 bg-foreground"
                />
              )}
              <span className="relative z-10 text-[12px] leading-4">{tab.label}</span>
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
