import * as React from 'react'

import { cn } from '@/lib/utils'

type TextareaProps = React.ComponentProps<'textarea'> & {
  ref?: React.Ref<HTMLTextAreaElement>
}

function Textarea({ className, ref, ...props }: TextareaProps): React.JSX.Element {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
