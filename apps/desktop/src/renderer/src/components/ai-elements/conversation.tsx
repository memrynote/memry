import { useEffect, useRef, type ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export type ConversationProps = ComponentProps<'div'>

export function Conversation({
  children,
  className,
  ...props
}: ConversationProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight })
  }, [children])

  return (
    <div
      ref={scrollRef}
      role="log"
      className={cn('relative min-h-0 flex-1 overflow-y-auto', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export type ConversationContentProps = ComponentProps<'div'>

export function ConversationContent({
  className,
  ...props
}: ConversationContentProps): React.JSX.Element {
  return <div className={cn('flex flex-col gap-3 px-4 py-3', className)} {...props} />
}
