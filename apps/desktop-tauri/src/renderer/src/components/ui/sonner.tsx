import { useTheme } from 'next-themes'
import { useEffect } from 'react'
import { getI18n } from 'react-i18next'
import { Toaster as Sonner, toast } from 'sonner'

import { commands } from '../../../../generated/bindings'
import { createLogger } from '@/lib/logger'

const log = createLogger('Toaster')

type ToasterProps = React.ComponentProps<typeof Sonner>

// ponytail: sonner v2 reads these for the toast bg; classNames lose the specificity tie → set the vars it reads
const toastStyle: React.CSSProperties & {
  '--normal-bg': string
  '--normal-text': string
  '--normal-border': string
} = {
  '--normal-bg': 'var(--background)',
  '--normal-text': 'var(--foreground)',
  '--normal-border': 'var(--border)'
}

/**
 * Tells the user once when the shell reloaded this page because its web process died. Asked from
 * the toaster, after it subscribed: a toast sent while a loading screen without a toaster shows
 * is dropped.
 */
function useCrashReloadNotice(): void {
  useEffect(() => {
    void Promise.resolve()
      .then(() => commands.shellTakeCrashReload())
      .then((reloaded) => {
        if (!reloaded) return
        const t = getI18n().getFixedT(null, 'system')
        toast.warning(t('startup.reloaded'), { duration: 10000 })
      })
      .catch((error: unknown) => log.warn('shell_take_crash_reload failed', error))
  }, [])
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()
  useCrashReloadNotice()

  return (
    <Sonner
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- next-themes yields an arbitrary string; sonner receives it unchanged
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      style={toastStyle}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground'
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
