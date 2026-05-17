import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

interface ThemeToggleProps {
  variant?: 'icon' | 'inline'
  className?: string
}

function ThemeSwitch({ isDark }: { isDark: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-7 w-14 shrink-0 items-center rounded-full border p-0.5 transition-colors duration-300',
        isDark
          ? 'border-white/15 bg-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]'
          : 'border-border/70 bg-paper-alt shadow-[inset_0_1px_1px_rgba(31,41,55,0.08)]'
      )}
    >
      <span className="absolute inset-0 flex items-center justify-between px-2">
        <Sun
          className={cn(
            'h-3.5 w-3.5 transition-colors',
            isDark ? 'text-paper/35' : 'text-terracotta'
          )}
        />
        <Moon
          className={cn('h-3.5 w-3.5 transition-colors', isDark ? 'text-paper' : 'text-muted/55')}
        />
      </span>
      <span
        className={cn(
          'relative z-10 flex h-6 w-6 items-center justify-center rounded-full transition-transform duration-300',
          isDark
            ? 'translate-x-7 bg-paper text-ink shadow-[0_4px_14px_rgba(0,0,0,0.35)]'
            : 'translate-x-0 bg-card text-terracotta shadow-[0_4px_14px_rgba(31,41,55,0.14)]'
        )}
      >
        {isDark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
      </span>
    </span>
  )
}

export function ThemeToggle({ variant = 'icon', className }: ThemeToggleProps) {
  const { theme, toggleTheme, mounted } = useTheme()
  const isDark = mounted && theme === 'dark'
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme'

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={label}
        className={cn(
          'inline-flex items-center justify-between rounded-2xl border border-border/60 bg-card/65 px-4 py-3 text-lg font-medium text-ink transition-colors hover:bg-card dark:border-white/10',
          className
        )}
      >
        <span className="flex flex-col items-start">
          <span className="font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted">
            Theme
          </span>
          {isDark ? 'Dark theme' : 'Light theme'}
        </span>
        <ThemeSwitch isDark={isDark} />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex rounded-full transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/45 focus-visible:ring-offset-2 focus-visible:ring-offset-paper',
        className
      )}
    >
      <ThemeSwitch isDark={isDark} />
    </button>
  )
}
