import { useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Slide {
  src: string
  title: string
  caption: string
  tint: string
  alt: string
}

/** Real screens from the iPhone beta (Debug build, staging sandbox vault). */
const SLIDES: readonly Slide[] = [
  {
    src: '/screenshots/ios/1-tasks.webp',
    title: 'Tasks',
    caption: 'Due dates, priorities and projects, the same list as your desktop.',
    tint: 'bg-tint-sage',
    alt: 'The Tasks tab on iPhone with overdue tasks, their dates, priorities and projects'
  },
  {
    src: '/screenshots/ios/2-note.webp',
    title: 'Notes',
    caption: 'Tags, properties and images, in the same markdown note.',
    tint: 'bg-tint-sky',
    alt: 'A travel note on iPhone with tags, properties and a cover photo of Istanbul'
  },
  {
    src: '/screenshots/ios/3-journal.webp',
    title: 'Journal',
    caption: 'One page a day, with its links and tasks.',
    tint: 'bg-tint-sand',
    alt: 'A journal day on iPhone with linked notes and tasks'
  },
  {
    src: '/screenshots/ios/4-calendar.webp',
    title: 'Calendar',
    caption: 'Your day with events and tasks together.',
    tint: 'bg-tint-mint',
    alt: 'The calendar day view on iPhone with events and tasks'
  },
  {
    src: '/screenshots/ios/5-inbox.webp',
    title: 'Inbox',
    caption: 'Links, photos and voice memos, sorted when you are ready.',
    tint: 'bg-tint-lilac',
    alt: 'The inbox on iPhone with links, photos and a transcribed voice memo'
  },
  {
    src: '/screenshots/ios/6-properties.webp',
    title: 'Properties',
    caption: 'Every field you track on the desktop, editable on the phone.',
    tint: 'bg-tint-peach',
    alt: 'A book note on iPhone with author, year, rating and status properties'
  },
  {
    src: '/screenshots/ios/7-collections.webp',
    title: 'Your vault',
    caption: 'The same folders, synced and end-to-end encrypted.',
    tint: 'bg-tint-rose',
    alt: 'The Notes tab on iPhone listing vault folders with note counts'
  }
]

/**
 * Side-scrolling strip of iPhone screens. Native horizontal scroll with snap points, so it
 * works by swipe, trackpad and keyboard; the arrow buttons scroll one card on wider screens.
 */
export function IosScreenshotCarousel() {
  const track = useRef<HTMLUListElement>(null)

  const scrollByCard = (direction: 1 | -1) => {
    const el = track.current
    const card = el?.querySelector('li')
    if (!el || !card) return
    // Logical direction: in RTL, "next" moves toward negative scrollLeft.
    const rtl = getComputedStyle(el).direction === 'rtl'
    el.scrollBy({ left: direction * (rtl ? -1 : 1) * (card.offsetWidth + 16), behavior: 'smooth' })
  }

  return (
    <section aria-label="iPhone screenshots" className="py-12">
      <div className="mx-auto flex max-w-7xl items-end justify-between gap-4 px-6">
        <h2 className="font-editorial text-2xl font-medium tracking-[-0.02em] text-ink">
          A look at the beta
        </h2>
        <div className="hidden gap-2 sm:flex">
          {([-1, 1] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              onClick={() => scrollByCard(direction)}
              aria-label={direction === 1 ? 'Next screenshot' : 'Previous screenshot'}
              className="grid size-10 place-items-center rounded-full border border-ink/[0.13] bg-card text-ink transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/50"
            >
              {direction === 1 ? (
                <ChevronRight className="size-5 rtl:rotate-180" aria-hidden />
              ) : (
                <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
              )}
            </button>
          ))}
        </div>
      </div>

      <ul
        ref={track}
        className="scrollbar-hide mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-ps-[max(1.5rem,calc((100vw-80rem)/2+1.5rem))] px-[max(1.5rem,calc((100vw-80rem)/2+1.5rem))] pb-2 motion-safe:scroll-smooth"
      >
        {SLIDES.map((slide) => (
          <li
            key={slide.src}
            className={cn(
              'flex h-[500px] w-[272px] shrink-0 snap-start flex-col overflow-hidden rounded-[28px] sm:h-[540px] sm:w-[300px]',
              slide.tint
            )}
          >
            <div className="px-6 pt-6">
              <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
                {slide.title}
              </h3>
              <p className="mt-1.5 min-h-[44px] text-[14px] leading-snug text-ink/70">
                {slide.caption}
              </p>
            </div>
            <div className="mt-5 px-7">
              <img
                src={slide.src}
                alt={slide.alt}
                width={640}
                height={1391}
                loading="lazy"
                decoding="async"
                className="block h-auto w-full rounded-t-[30px] border-x-[6px] border-t-[6px] border-ink/90 bg-white"
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
