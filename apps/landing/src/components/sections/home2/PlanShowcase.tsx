import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { HomeSection, MegaCard, SectionTitle } from '@/components/sections/home2/primitives'
import { TasksWidget } from '@/components/sections/home2/widgets/TasksWidget'
import { CalendarWidget } from '@/components/sections/home2/widgets/CalendarWidget'
import { JournalWidget } from '@/components/sections/home2/widgets/JournalWidget'
import { InboxWidget } from '@/components/sections/home2/widgets/InboxWidget'

/* ── Quadrant card — heading links to the feature page, body is a live widget ── */

interface QuadrantProps {
  title: string
  desc: string
  href: string
  children: ReactNode
}

function Quadrant({ title, desc, href, children }: QuadrantProps) {
  return (
    <article className="flex flex-col gap-5 rounded-2xl border border-ink/5 bg-card p-5 shadow-sm sm:p-6">
      <div>
        <h3 className="text-base font-semibold text-ink">
          <Link
            to={href}
            className="group inline-flex items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2"
          >
            {title}
            <span
              aria-hidden
              className="text-terracotta opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              →
            </span>
          </Link>
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">{desc}</p>
      </div>
      <div>
        {children}
        <p className="mt-2 text-xs text-muted">Live demo — try it</p>
      </div>
    </article>
  )
}

/**
 * Plan mega-card — warm sand tint, 2×2 quadrant of Tasks / Calendar / Journal / Inbox,
 * each with a live interactive widget linking to its feature page.
 */
export function PlanShowcase() {
  return (
    <HomeSection>
      <MegaCard tint="sand" eyebrow="PLAN">
        <SectionTitle
          title="Planning that doesn't feel like work"
          sub="Tasks, calendar, journal, and inbox — next to your notes, not in four other apps."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-5">
          <Quadrant
            title="Tasks"
            desc="A today view with natural due dates — “tomorrow” just works."
            href="/features/tasks"
          >
            <TasksWidget />
          </Quadrant>
          <Quadrant
            title="Calendar"
            desc="Notes and events together, on one calendar."
            href="/features/calendar"
          >
            <CalendarWidget />
          </Quadrant>
          <Quadrant
            title="Journal"
            desc="A daily note that's ready when you are. No streaks, no guilt."
            href="/features/journal"
          >
            <JournalWidget />
          </Quadrant>
          <Quadrant
            title="Inbox"
            desc="Capture now, sort later — text, links, voice."
            href="/features/inbox"
          >
            <InboxWidget />
          </Quadrant>
        </div>
      </MegaCard>
    </HomeSection>
  )
}
