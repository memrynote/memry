import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ScrollText, Map } from 'lucide-react'
import { HomeSection, SectionTitle } from '@/components/sections/home2/primitives'
import { trackLandingEvent } from '@/lib/analytics'

const EASE = [0.16, 1, 0.3, 1] as const

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function RedditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M14.238 15.348c.085.084.085.221 0 .306-.465.462-1.194.687-2.231.687l-.008-.002-.008.002c-1.036 0-1.766-.225-2.231-.688-.085-.084-.085-.221 0-.305.084-.084.222-.084.307 0 .379.377 1.008.561 1.924.561l.008.002.008-.002c.915 0 1.544-.184 1.924-.561.085-.084.223-.084.307 0zm-3.44-2.418c0-.507-.414-.919-.922-.919-.509 0-.923.412-.923.919 0 .506.414.918.923.918.508.001.922-.411.922-.918zm13.202-.93c0 6.627-5.373 12-12 12s-12-5.373-12-12 5.373-12 12-12 12 5.373 12 12zm-5-.129c0-.851-.695-1.543-1.55-1.543-.417 0-.795.167-1.074.435-1.056-.695-2.485-1.137-4.066-1.194l.865-2.724 2.343.549-.003.034c0 .696.569 1.262 1.268 1.262.699 0 1.267-.566 1.267-1.262s-.568-1.262-1.267-1.262c-.537 0-.994.335-1.179.804l-2.525-.592c-.11-.027-.223.037-.257.145l-.965 3.038c-1.656.02-3.155.466-4.258 1.181-.277-.255-.644-.415-1.05-.415-.854.001-1.549.693-1.549 1.544 0 .566.311 1.056.768 1.325-.03.164-.05.331-.05.5 0 2.281 2.805 4.137 6.253 4.137s6.253-1.856 6.253-4.137c0-.16-.017-.317-.044-.472.486-.261.82-.766.82-1.353zm-4.872.141c-.509 0-.922.412-.922.919 0 .506.414.918.922.918s.922-.412.922-.918c0-.507-.413-.919-.922-.919z" />
    </svg>
  )
}

interface LoopCard {
  title: string
  line: string
  href: string
  icon: ReactNode
  target: string
}

const LOOP_CARDS: LoopCard[] = [
  {
    title: 'Changelog',
    line: 'What shipped, release by release.',
    href: '/changelog',
    icon: <ScrollText className="h-5 w-5" aria-hidden />,
    target: 'home-community:changelog'
  },
  {
    title: 'Roadmap',
    line: 'What we are building next — in the open.',
    href: '/roadmap',
    icon: <Map className="h-5 w-5" aria-hidden />,
    target: 'home-community:roadmap'
  },
  {
    title: 'X / Twitter',
    line: 'Follow the build in public — @h4yfans.',
    href: 'https://x.com/h4yfans',
    icon: <XIcon />,
    target: 'home-community:twitter'
  },
  {
    title: 'Reddit',
    line: 'Questions, feedback and ideas — r/MemryNote.',
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
        className="flex h-10 w-10 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta"
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
          title="Stay in the loop"
          sub="Follow what's shipping — and help decide what comes next."
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
