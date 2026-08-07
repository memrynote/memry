import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Star, X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { STAR_PROMPT_EVENT, STAR_PROMPT_KEY } from './star-prompt'

const MEMRY_REPOSITORY_URL = 'https://github.com/memrynote/memry'

/**
 * GitHub's own mark, inlined rather than fetched: the app is offline-first, and
 * a remote logo would put a network request on a card that exists to ask for a
 * favour. `currentColor` lets it follow the theme.
 */
const GithubMark = ({ className }: { className?: string }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
)

/**
 * Bottom-right card shown once the first-run tour ends, asking for a GitHub star.
 *
 * It stays until the user answers — starring or dismissing both write `'done'`.
 * A user who quits while it is still `'pending'` sees it again next launch, which
 * is the point of a persistent card: closing the app is not an answer.
 */
export function GithubStarCard(): React.JSX.Element | null {
  const { t } = useT('common')
  const [visible, setVisible] = useState(() => localStorage.getItem(STAR_PROMPT_KEY) === 'pending')

  useEffect(() => {
    // Same test as the mount read, so a stray event can never resurrect a card
    // the user already answered.
    const show = (): void => {
      if (localStorage.getItem(STAR_PROMPT_KEY) === 'pending') setVisible(true)
    }
    window.addEventListener(STAR_PROMPT_EVENT, show)
    return () => window.removeEventListener(STAR_PROMPT_EVENT, show)
  }, [])

  if (!visible) return null

  const settle = (): void => {
    localStorage.setItem(STAR_PROMPT_KEY, 'done')
    setVisible(false)
  }

  return (
    <div
      role="region"
      aria-label={t('onboarding.starPrompt.title')}
      className={cn(
        'fixed bottom-4 end-4 z-50 w-[min(21rem,calc(100vw-2rem))]',
        'rounded-xl border border-border/60 bg-popover/95 p-4 backdrop-blur-md',
        'shadow-[0_16px_40px_rgba(0,0,0,0.22)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.45)]',
        'animate-in fade-in slide-in-from-bottom-4 motion-reduce:animate-none'
      )}
    >
      <div className="flex items-start gap-3">
        <GithubMark className="mt-0.5 size-5 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('onboarding.starPrompt.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('onboarding.starPrompt.body')}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={settle}
          aria-label={t('button.close')}
          className="-me-1.5 -mt-1.5 shrink-0 text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <Button asChild size="sm" className="mt-3 w-full">
        <a href={MEMRY_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" onClick={settle}>
          <Star />
          {t('onboarding.starPrompt.action')}
        </a>
      </Button>
    </div>
  )
}
