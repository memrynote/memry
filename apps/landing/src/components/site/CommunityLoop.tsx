import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Link } from 'react-router'
import { Mascot } from '@/components/ui/mascot'
import { HomeSection, SectionTitle } from '@/components/site/primitives'
import { trackLandingEvent } from '@/lib/analytics'

const EASE = [0.16, 1, 0.3, 1] as const

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  )
}

function RedditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" />
    </svg>
  )
}

interface LoopCard {
  title: string
  line: string
  href: string
  icon: ReactNode
  mascot?: boolean
  target: string
}

const LOOP_CARDS: LoopCard[] = [
  {
    title: 'Changelog',
    line: 'What shipped, release by release.',
    href: '/changelog',
    icon: <Mascot src="/mascots/change-log.webp" className="h-8 w-8" />,
    mascot: true,
    target: 'home-community:changelog'
  },
  {
    title: 'Roadmap',
    line: 'What we are building next, in the open.',
    href: '/roadmap',
    icon: <Mascot src="/mascots/roadmap.webp" className="h-8 w-8" />,
    mascot: true,
    target: 'home-community:roadmap'
  },
  {
    title: 'X / Twitter',
    line: 'Follow the build in public: @h4yfans.',
    href: 'https://x.com/h4yfans',
    icon: <XIcon />,
    target: 'home-community:twitter'
  },
  {
    title: 'Reddit',
    line: 'Questions, feedback and ideas: r/MemryNote.',
    href: 'https://www.reddit.com/r/MemryNote/',
    icon: <RedditIcon />,
    target: 'home-community:reddit'
  }
]

function isExternalHref(href: string) {
  return href.startsWith('http')
}

function LoopCardTile({ card, index }: { card: LoopCard; index: number }) {
  const cardClass = [
    'group flex h-full flex-col items-start gap-4 rounded-2xl border border-border/70 bg-card',
    'p-6 text-start shadow-sm transition-all duration-300 ease-out',
    'hover:-translate-y-0.5 hover:shadow-card'
  ].join(' ')

  const content = (
    <>
      <span
        aria-hidden
        className={[
          'flex h-10 w-10 items-center justify-center rounded-xl',
          card.mascot ? '' : 'bg-terracotta/10 text-terracotta'
        ].join(' ')}
      >
        {card.icon}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-base font-medium text-ink transition-colors group-hover:text-terracotta">
          {card.title}
        </span>
        <span className="text-sm leading-relaxed text-muted">{card.line}</span>
      </span>
    </>
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, ease: EASE, delay: index * 0.08 }}
      className="h-full"
    >
      {isExternalHref(card.href) ? (
        <a
          href={card.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cardClass}
          onClick={() => trackLandingEvent('landing_external_click', card.target)}
        >
          {content}
        </a>
      ) : (
        <Link
          to={card.href}
          className={cardClass}
          onClick={() => trackLandingEvent('landing_nav_click', card.target)}
        >
          {content}
        </Link>
      )}
    </motion.div>
  )
}

export function CommunityLoop() {
  return (
    <HomeSection>
      <div className="mx-auto w-full max-w-6xl">
        <SectionTitle
          eyebrow="Community"
          title="Built in the open"
          sub="Follow what's shipping, and help decide what comes next."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 md:gap-5">
          {LOOP_CARDS.map((card, index) => (
            <LoopCardTile key={card.title} card={card} index={index} />
          ))}
        </div>
      </div>
    </HomeSection>
  )
}
