import { useEffect, useState } from 'react'
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

/** A wait that ends sooner than this never shows the spinner, so fast loads do not flash. */
const SPINNER_DELAY_MS = 150

/** A spinner for a wait that is usually instant but can run long. */
function DelayedSpinner({ className, ...props }: React.ComponentProps<typeof Spinner>) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SPINNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null
  return (
    <Spinner
      className={cn('animate-in fade-in duration-150 motion-reduce:animate-none', className)}
      {...props}
    />
  )
}

export { Spinner, DelayedSpinner }
