import { useTheme } from 'next-themes'
import { Toaster as Sonner } from 'sonner'

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

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

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
