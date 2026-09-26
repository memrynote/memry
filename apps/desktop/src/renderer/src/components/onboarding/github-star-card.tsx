import { useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Github, Star, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { STAR_PROMPT_EVENT, STAR_PROMPT_KEY } from './star-prompt'

const MEMRY_REPOSITORY_URL = 'https://github.com/memrynote/memry'
/** How long the thank-you line stays before the card collapses. */
const THANKS_MS = 3000

type CardState = 'hidden' | 'ask' | 'thanks'

/**
 * Sidebar card, just above the footer dock, asking for a GitHub star once the
 * first-run tour ends.
 *
 * It stays until the user answers: starring or dismissing both write `'done'`.
 * A user who quits while it is still `'pending'` sees it again next launch, which
 * is the point of a persistent card: closing the app is not an answer. Starring
 * swaps the card for a short thank-you, then it collapses for good.
 */
export function GithubStarCard(): React.JSX.Element | null {
  const { t } = useT('common')
  const [state, setState] = useState<CardState>(() =>
    localStorage.getItem(STAR_PROMPT_KEY) === 'pending' ? 'ask' : 'hidden'
  )
  const thanksTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Same test as the mount read, so a stray event can never resurrect a card
    // the user already answered.
    const show = (): void => {
      if (localStorage.getItem(STAR_PROMPT_KEY) === 'pending') setState('ask')
    }
    window.addEventListener(STAR_PROMPT_EVENT, show)
    return () => {
      window.removeEventListener(STAR_PROMPT_EVENT, show)
      if (thanksTimer.current) clearTimeout(thanksTimer.current)
    }
  }, [])

  if (state === 'hidden') return null

  const settle = (): void => {
    localStorage.setItem(STAR_PROMPT_KEY, 'done')
  }

  const CARD =
    'mb-2 rounded-[10px] border border-sidebar-border bg-background shadow-xs animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none group-data-[collapsible=icon]:hidden'

  if (state === 'thanks') {
    return (
      <output className={cn(CARD, 'flex items-center gap-2 px-3 py-2.5')}>
        <Star
          aria-hidden="true"
          className="size-4 shrink-0 fill-[var(--tint)] text-[var(--tint)]"
        />
        <span className="text-xs text-text-secondary">{t('sidebarStar.thanks')}</span>
      </output>
    )
  }

  return (
    <section aria-label={t('sidebarStar.title')} className={cn(CARD, 'flex flex-col gap-2 p-3')}>
      <div className="flex items-center gap-2">
        <Github aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {t('sidebarStar.title')}
        </p>
        <button
          type="button"
          onClick={() => {
            settle()
            setState('hidden')
          }}
          aria-label={t('button.close')}
          className="-me-1 flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <p className="text-xs leading-[17px] text-text-secondary">{t('sidebarStar.body')}</p>
      <div className="flex gap-1.5">
        <a
          href={MEMRY_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            settle()
            setState('thanks')
            thanksTimer.current = setTimeout(() => setState('hidden'), THANKS_MS)
          }}
          className="flex h-[26px] items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]"
        >
          <Star aria-hidden="true" className="size-3.5 fill-amber-400 text-amber-400" />
          {t('sidebarStar.star')}
        </a>
        <button
          type="button"
          onClick={() => {
            settle()
            setState('hidden')
          }}
          className="flex h-[26px] items-center rounded-md bg-sidebar-accent px-2.5 text-xs text-text-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]"
        >
          {t('sidebarStar.later')}
        </button>
      </div>
    </section>
  )
}
