import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { TINT_CLASSES, type MegaCardTint } from '@/lib/site-tints'

const EASE = [0.16, 1, 0.3, 1] as const

const RISE_INITIAL = { opacity: 0, y: 24 }
const RISE_ANIMATE = { opacity: 1, y: 0 }
const RISE_VIEWPORT = { once: true, margin: '-80px' } as const
const RISE_TRANSITION = { duration: 0.8, ease: EASE }

export type { MegaCardTint }

export interface MegaCardProps {
  tint: MegaCardTint
  eyebrow?: string
  className?: string
  children: ReactNode
}

/**
 * Big pastel rounded section card — the Craft-style mega-card in MemryNote tints.
 * max-w-6xl centered, generous padding, overflow-hidden so visuals can bleed off the edges.
 */
export function MegaCard({ tint, eyebrow, className, children }: MegaCardProps) {
  return (
    <motion.div
      initial={RISE_INITIAL}
      whileInView={RISE_ANIMATE}
      viewport={RISE_VIEWPORT}
      transition={RISE_TRANSITION}
      className={cn(
        'relative mx-auto w-full max-w-6xl overflow-hidden rounded-3xl border border-ink/5',
        'px-6 py-14 sm:px-10 md:px-16 md:py-20',
        TINT_CLASSES[tint],
        className
      )}
    >
      {eyebrow && (
        <p className="mb-6 text-center font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
          {eyebrow}
        </p>
      )}
      {children}
    </motion.div>
  )
}

export interface SectionTitleProps {
  eyebrow?: string
  title: ReactNode
  sub?: ReactNode
  align?: 'center' | 'start'
  className?: string
  titleClassName?: string
}

/** Consistent big warm section heading, optionally with eyebrow label and sub line. */
export function SectionTitle({
  eyebrow,
  title,
  sub,
  align = 'center',
  className,
  titleClassName
}: SectionTitleProps) {
  const centered = align === 'center'

  return (
    <motion.div
      initial={RISE_INITIAL}
      whileInView={RISE_ANIMATE}
      viewport={RISE_VIEWPORT}
      transition={RISE_TRANSITION}
      className={cn('mb-10 md:mb-14', centered ? 'text-center' : 'text-start', className)}
    >
      {eyebrow && (
        <p className="mb-4 font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
          {eyebrow}
        </p>
      )}
      <h2
        className={cn(
          'display-section max-w-3xl text-ink text-balance',
          centered && 'mx-auto',
          titleClassName
        )}
      >
        {title}
      </h2>
      {sub && <p className={cn('section-sub mt-5 max-w-2xl', centered && 'mx-auto')}>{sub}</p>}
    </motion.div>
  )
}

export interface FeatureChipProps {
  icon?: ReactNode
  label: string
  href?: string
  /** Trailing affordance — hero pill links use an arrow here. */
  trailingIcon?: ReactNode
  className?: string
}

function isExternalHref(href: string) {
  return /^(https?:|mailto:)/.test(href)
}

/**
 * Same-page anchors (`#pillar-notes`) must stay plain <a>: routing them through
 * react-router's Link resolves them against the current route and breaks the scroll.
 */
function isAnchorHref(href: string) {
  return href.startsWith('#')
}

/**
 * Small rounded chip card with hover lift. Picks its element from the href: plain <a> for
 * same-page anchors, new-tab <a> for external links, Link for internal routes.
 */
export function FeatureChip({ icon, label, href, trailingIcon, className }: FeatureChipProps) {
  const chipClass = cn(
    'group inline-flex items-center gap-2.5 rounded-2xl border border-border/70 bg-card',
    'px-4 py-3 text-sm font-medium text-ink shadow-sm',
    'transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-card',
    className
  )

  const content = (
    <>
      {icon && (
        <span aria-hidden className="flex shrink-0 items-center justify-center">
          {icon}
        </span>
      )}
      <span className="whitespace-nowrap">{label}</span>
      {trailingIcon && (
        <span aria-hidden className="flex shrink-0 items-center justify-center">
          {trailingIcon}
        </span>
      )}
    </>
  )

  if (href && isAnchorHref(href)) {
    return (
      <a href={href} className={chipClass}>
        {content}
      </a>
    )
  }

  if (href && isExternalHref(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={chipClass}>
        {content}
      </a>
    )
  }

  if (href) {
    return (
      <Link to={href} className={chipClass}>
        {content}
      </Link>
    )
  }

  return <span className={chipClass}>{content}</span>
}

/**
 * The dashed seam between two stacked sections. It stops where the page grid's vertical
 * rails stand rather than bleeding to the viewport edge, so the grid reads as a frame.
 */
export function SectionRule() {
  return <div aria-hidden className="section-rule" />
}

export interface HomeSectionProps {
  children: ReactNode
  className?: string
  id?: string
}

/** Plain-width section wrapper — shared vertical rhythm and edge padding for home2 sections. */
export function HomeSection({ children, className, id }: HomeSectionProps) {
  return (
    <section id={id} className={cn('px-4 py-10 sm:px-6 md:py-14', className)}>
      {children}
    </section>
  )
}
