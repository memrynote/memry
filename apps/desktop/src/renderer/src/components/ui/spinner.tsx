import { Loader2Icon } from 'lucide-react'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'

function Spinner({ className, 'aria-label': ariaLabel, ...props }: React.ComponentProps<'svg'>) {
  const { t } = useT('common')

  return (
    <Loader2Icon
      role="status"
      aria-label={ariaLabel ?? t('state.loading')}
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}

export { Spinner }
