'use client'

import type { ComponentProps, ReactNode } from 'react'
import { BookIcon, ChevronDownIcon } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export type SourcesProps = ComponentProps<'div'>

export const Sources = ({ className, ...props }: SourcesProps): React.JSX.Element => (
  <Collapsible className={cn('not-prose mb-4 text-primary text-xs', className)} {...props} />
)

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number
  label?: ReactNode
}

export const SourcesTrigger = ({
  className,
  count,
  label,
  children,
  ...props
}: SourcesTriggerProps): React.JSX.Element => (
  <CollapsibleTrigger className={cn('flex items-center gap-2', className)} {...props}>
    {children ?? (
      <>
        <p className="font-medium">{label ?? count}</p>
        <ChevronDownIcon className="h-4 w-4" />
      </>
    )}
  </CollapsibleTrigger>
)

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>

export const SourcesContent = ({ className, ...props }: SourcesContentProps): React.JSX.Element => (
  <CollapsibleContent
    className={cn(
      'mt-3 flex w-fit flex-col gap-2',
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    {...props}
  />
)

export type SourceProps = ComponentProps<'a'>

export const Source = ({ href, title, children, ...props }: SourceProps): React.JSX.Element => (
  <a className="flex items-center gap-2" href={href} rel="noreferrer" target="_blank" {...props}>
    {children ?? (
      <>
        <BookIcon className="h-4 w-4" />
        <span className="block font-medium">{title}</span>
      </>
    )}
  </a>
)
