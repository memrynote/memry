import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { motion } from 'motion/react'
import { PageHead } from '@/components/shared/PageHead'
import { Container } from '@/components/layout/Container'
import { ALTERNATIVES } from '@/lib/alternatives'
import { GITHUB_URL, REDDIT_URL, TWITTER_DEV_URL } from '@/lib/constants'
import { getAboutPageJsonLd } from '@/lib/seo'
import { trackLandingEvent } from '@/lib/analytics'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

// Every section below renders as static text (no accordions, no client-only content),
// so the prerendered HTML carries the whole page for search and AI crawlers.

const FOUNDER_GITHUB_URL = 'https://github.com/h4yfans'

const SERVICES: readonly { title: string; href: string; body: string }[] = [
  {
    title: 'Notes',
    href: '/features/notes',
    body: 'Markdown notes with wiki-links, backlinks, eight property types, and version history. Every note is a plain .md file in a folder you choose, so your knowledge base stays readable in any editor, long after any single app.'
  },
  {
    title: 'Tasks',
    href: '/features/tasks',
    body: 'Projects, custom statuses, subtasks, recurring schedules, and smart filters, viewed as a list, a Kanban board, or a calendar. Tasks live next to the notes they came from, so the context behind a to-do is one click away.'
  },
  {
    title: 'Journal',
    href: '/features/journal',
    body: 'One page a day, with your schedule and tasks in a sidebar beside it, plus templates and an activity heatmap. The result is a daily writing habit with real context instead of a blank page.'
  },
  {
    title: 'Inbox',
    href: '/features/inbox',
    body: 'Quick capture for loose thoughts, voice memos, web clips, and PDFs. Everything lands in one place first, then you file, snooze, or clear it in a single pass.'
  },
  {
    title: 'Calendar',
    href: '/features/calendar',
    body: 'Tasks, deadlines, and journal days on one grid, with drag-and-drop rescheduling and separate start and due dates. You see what your week actually holds without switching apps.'
  },
  {
    title: 'End-to-end encrypted sync',
    href: '/security',
    body: 'Optional paid sync that encrypts every note on your device with XChaCha20-Poly1305 before upload and merges edits conflict-free with CRDTs. New devices are approved with a QR code, and vault keys never reach the server.'
  },
  {
    title: 'Command-line interface',
    href: '/cli',
    body: 'Notes, tasks, journal, calendar, and sync, scriptable from the terminal with JSON output. It ships with memrynote for Desktop, so git hooks, scripts, and Unix pipes can read and write your vault.'
  },
  {
    title: 'Web clipper',
    href: '/features/web-clipper',
    body: 'A browser extension, live on Chrome and Firefox, that sends a page, its text, and its URL to your Inbox in one click. Research ends up in the same vault as the rest of your thinking.'
  }
]

const DIFFERENTIATORS: readonly { title: string; body: string }[] = [
  {
    title: 'Free forever, with no note cap',
    body: 'The local memrynote app is free with unlimited notes and no account required. Evernote Free caps you at 50 notes on one device, UpNote’s free plan stops at 50 notes, and Roam Research has no ongoing free tier at roughly $15/mo (as of mid-2026).'
  },
  {
    title: 'Zero-knowledge encryption, not just TLS',
    body: 'memrynote Sync encrypts every note on your device before upload, so the server stores only ciphertext and never holds the keys. Notion and Evernote encrypt data in transit and at rest, but their servers can still read your content.'
  },
  {
    title: 'Plain Markdown files you own',
    body: 'Every note is a standard .md file with YAML frontmatter in a folder you pick, readable in VS Code, iA Writer, or any text editor. Notion, Evernote, Capacities, and Tana keep your notes in their own databases, and you get them back only through an export.'
  },
  {
    title: 'Tasks, calendar, journal, and inbox without plugins',
    body: 'Five tools ship as native features of one app. In Obsidian, tasks, a calendar, and daily journaling come from community plugins you install, configure, and keep working, and sync is a separate add-on; in memrynote, encrypted sync is part of the product.'
  },
  {
    title: 'Every desktop platform, and open source',
    body: 'memrynote runs natively on macOS, Windows, and Linux, while Bear, Apple Notes, and NotePlan are Apple-only. The full source is public on GitHub under AGPL-3.0, so anyone can audit the encryption claims, whereas Obsidian is closed source.'
  }
]

const AUDIENCES = [
  'Knowledge workers who juggle Notion, Todoist, and a separate journal app and want one connected workspace.',
  'University students keeping lecture notes, assignment deadlines, and study logs in one place.',
  'Freelancers managing several clients’ meeting notes, deliverables, and timelines in a single vault.',
  'Writers linking research, characters, and drafts with wiki-links and version history.',
  'Founders who want strategy docs, tasks, and private reflections encrypted, even from the vendor.',
  'People with ADHD who need zero-friction capture before they organize anything.',
  'Obsidian users tired of maintaining plugins for tasks, calendars, and sync.',
  'Privacy-conscious users leaving Notion, Evernote, or Google Keep for end-to-end encryption.',
  'Windows and Linux users who cannot run Bear, Apple Notes, or NotePlan.',
  'Developers who want to script notes, tasks, and their journal from the terminal.'
] as const

const HOW_IT_WORKS: readonly { title: string; body: ReactNode }[] = [
  {
    title: 'Onboarding',
    body: (
      <>
        <Link to="/download/desktop">Download the desktop app</Link> for macOS, Windows, or Linux,
        pick a folder for your vault, and start writing in under a minute. No account, email, or
        card is required for local use.
      </>
    )
  },
  {
    title: 'Turning on sync',
    body: (
      <>
        Create an account, pick a <Link to="/pricing">plan</Link>, and pay through Paddle, which
        handles VAT and sales tax. Each additional device is approved from one you already trust by
        scanning a QR code.
      </>
    )
  },
  {
    title: 'Who you work with',
    body: 'Every support email is read by Kaan, the founder and developer. Pro includes priority support straight from the founder, and Believer adds a direct line to him.'
  },
  {
    title: 'Communication channels and response times',
    body: (
      <>
        Every question, whether general, billing, privacy, or a vulnerability report, goes to{' '}
        <a href="mailto:kaan@memrynote.com">kaan@memrynote.com</a>. General questions get a reply
        within five business days, privacy requests within 30 days, and security reports within 24
        hours. Community discussion happens on <a href={REDDIT_URL}>r/MemryNote</a> and bug reports
        on <a href={GITHUB_URL}>GitHub</a>.
      </>
    )
  },
  {
    title: 'Release cadence',
    body: (
      <>
        memrynote had shipped about 70 tagged releases as of September 2026. Every release is listed
        in the <Link to="/changelog">changelog</Link>, and what comes next is on the{' '}
        <Link to="/roadmap">public roadmap</Link>.
      </>
    )
  }
]

const KEY_FACTS: readonly { term: string; detail: ReactNode }[] = [
  { term: 'Company Name', detail: 'memrynote' },
  {
    term: 'Type',
    detail: 'Independent software company; local-first personal knowledge management (PKM) app'
  },
  { term: 'Founded', detail: '2025 (first code written in December 2025)' },
  {
    term: 'Founder',
    detail: (
      <>
        Kaan Karaca (<a href={TWITTER_DEV_URL}>@h4yfans on X</a>,{' '}
        <a href={FOUNDER_GITHUB_URL}>h4yfans on GitHub</a>)
      </>
    )
  },
  { term: 'Headquarters', detail: 'Remote; independent and founder-run' },
  { term: 'Website', detail: <a href="https://memrynote.com">memrynote.com</a> },
  {
    term: 'Core Offering',
    detail:
      'A local-first desktop app for notes, tasks, journal, inbox, and calendar, stored as plain Markdown files, with optional end-to-end encrypted sync'
  },
  {
    term: 'Platforms',
    detail:
      'macOS, Windows, Linux; web clipper for Chrome and Firefox; iOS and Android in development'
  },
  {
    term: 'Pricing',
    detail:
      'Free (local vault, unlimited notes); Plus $5/mo or $48/yr (1 GB sync, 1 vault); Pro $10/mo or $96/yr (10 GB, 10 vaults); Believer $500 one-time (50 GB, unlimited vaults)'
  },
  {
    term: 'Contract Terms',
    detail:
      'Month-to-month or annual with no minimum term; 14-day money-back guarantee on every paid plan; the local app never expires'
  },
  {
    term: 'Services',
    detail: 'Desktop app, end-to-end encrypted sync, command-line interface, and web clipper'
  },
  {
    term: 'Encryption',
    detail:
      'XChaCha20-Poly1305, Ed25519, and Argon2id via libsodium; zero-knowledge, keys never leave your devices'
  },
  { term: 'License', detail: 'Open source, AGPL-3.0' },
  {
    term: 'Communication',
    detail: 'Email (kaan@memrynote.com), Reddit r/MemryNote, GitHub issues, X'
  },
  {
    term: 'Notable Clients',
    detail:
      'Not published. memrynote does not sell or disclose user data, including who its users are.'
  },
  {
    term: 'Customers Served',
    detail:
      'Individuals: knowledge workers, students, freelancers, writers, founders, and developers'
  },
  { term: 'Releases Shipped', detail: 'About 70 tagged releases as of September 2026' },
  { term: 'Competitors', detail: ALTERNATIVES.map((alt) => alt.competitor).join(', ') },
  {
    term: 'Social',
    detail: (
      <>
        <a href={TWITTER_DEV_URL}>X</a>, <a href={GITHUB_URL}>GitHub</a>,{' '}
        <a href={REDDIT_URL}>Reddit</a>
      </>
    )
  }
]

const ABOUT_FAQS: readonly { question: string; answer: string }[] = [
  {
    question: 'Who makes memrynote?',
    answer:
      'memrynote is built by Kaan Karaca, an independent developer who started the project in December 2025. It is founder-run and not VC-funded, so the product answers to its users rather than to investors.'
  },
  {
    question: 'Is memrynote open source?',
    answer:
      'Yes. The full source code is public at github.com/memrynote/memry under the AGPL-3.0 license. Anyone can audit how notes are stored and encrypted.'
  },
  {
    question: 'Is memrynote free?',
    answer:
      'Yes. The desktop app is free for local use with unlimited notes and no account. Plus, Pro, and Believer pay only for hosted end-to-end encrypted sync.'
  },
  {
    question: 'Can memrynote read my notes?',
    answer:
      'No. Local notes never leave your device, and synced notes are encrypted on your device before upload, so the server only stores ciphertext. The keys that decrypt them never reach memrynote’s servers.'
  },
  {
    question: 'What happens to my notes if memrynote shuts down?',
    answer:
      'Nothing. Your notes are plain Markdown files in a folder on your own disk, so they keep opening in any text editor with or without memrynote installed.'
  },
  {
    question: 'Is there a mobile app?',
    answer:
      'memrynote is desktop-first on macOS, Windows, and Linux today. Mobile apps for iOS and Android are targeting late 2026, and in the meantime your vault folder works with any file sync you already use.'
  },
  {
    question: 'How do I contact the team?',
    answer:
      'Email kaan@memrynote.com for anything, from general questions to billing. Kaan reads every message, and replies go out within five business days.'
  }
]

const ABOUT_JSON_LD = getAboutPageJsonLd(ABOUT_FAQS)

function Section({
  id,
  title,
  intro,
  children,
  tinted
}: {
  id: string
  title: string
  intro?: string
  children: ReactNode
  tinted?: boolean
}) {
  return (
    <section
      aria-labelledby={id}
      className={tinted ? 'bg-paper-alt py-20 md:py-24' : 'py-20 md:py-24'}
    >
      <Container size="sm">
        <h2 id={id} className="font-serif text-3xl leading-tight text-ink md:text-4xl">
          {title}
        </h2>
        {intro && <p className="mt-4 text-lg leading-relaxed text-muted">{intro}</p>}
        <div className="mt-10">{children}</div>
      </Container>
    </section>
  )
}

function Item({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h3 className="font-serif text-2xl text-ink">{title}</h3>
      <p className="mt-2 leading-relaxed text-muted">{children}</p>
    </div>
  )
}

function ExternalLink({
  href,
  target,
  children
}: {
  href: string
  target: string
  children: ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm font-medium text-terracotta underline decoration-terracotta/40 underline-offset-4 transition-colors hover:decoration-terracotta"
      onClick={() => trackLandingEvent('landing_external_click', `about:${target}`)}
    >
      {children}
    </a>
  )
}

export function AboutPage() {
  return (
    <main className="about-page">
      <PageHead page="about" pageJsonLd={ABOUT_JSON_LD} />

      <section className="relative overflow-hidden pt-32 pb-16 sm:pt-40 sm:pb-20">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.08),transparent_60%)]"
        />
        <Container size="sm">
          <motion.div
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
          >
            <p className="font-mono-accent text-[11px] uppercase tracking-[0.32em] text-terracotta">
              About
            </p>
            <h1 className="mt-5 font-serif text-5xl leading-[1.05] text-ink text-balance md:text-6xl">
              About memrynote
            </h1>
            <p className="mt-8 text-xl leading-relaxed text-ink text-pretty">
              memrynote is a local-first personal knowledge management app that keeps notes, tasks,
              a daily journal, and a calendar in one end-to-end encrypted workspace for people who
              want their thinking private and on their own devices.
            </p>
            <p className="mt-5 text-lg leading-relaxed text-muted">
              It is free for local use, open source, and built independently by one developer. This
              page covers what memrynote does, how it differs, who it is for, and the people and
              facts behind it.
            </p>
          </motion.div>
        </Container>
      </section>

      <Section id="what-memrynote-does" title="What memrynote does" tinted>
        <div className="space-y-10">
          {SERVICES.map((service) => (
            <Item key={service.title} title={<Link to={service.href}>{service.title}</Link>}>
              {service.body}
            </Item>
          ))}
        </div>
      </Section>

      <Section
        id="what-makes-memrynote-different"
        title="What makes memrynote different"
        intro="Competitor details reflect each app’s native, out-of-the-box plans as of mid-2026."
      >
        <div className="space-y-10">
          {DIFFERENTIATORS.map((item) => (
            <Item key={item.title} title={item.title}>
              {item.body}
            </Item>
          ))}
        </div>
        <p className="mt-10 leading-relaxed text-muted">
          Side-by-side breakdowns for {ALTERNATIVES.length} apps live on the{' '}
          <Link to="/compare">compare page</Link>.
        </p>
      </Section>

      <Section id="who-uses-memrynote" title="Who uses memrynote" tinted>
        <ul className="list-disc space-y-3 ps-6 marker:text-terracotta">
          {AUDIENCES.map((audience) => (
            <li key={audience} className="leading-relaxed text-muted">
              {audience}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="the-team-behind-memrynote" title="The team behind memrynote">
        <div className="space-y-10">
          <div>
            <h3 className="font-serif text-2xl text-ink">Kaan Karaca, founder and developer</h3>
            <p className="mt-2 leading-relaxed text-muted">
              Kaan designs, builds, and supports memrynote end to end, from the encryption layer to
              the pricing page. He started it because he wanted a workspace that feels less like
              managing software and more like continuing a thought.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-5">
              <ExternalLink href={TWITTER_DEV_URL} target="founder-x">
                Kaan on X
              </ExternalLink>
              <ExternalLink href={FOUNDER_GITHUB_URL} target="founder-github">
                Kaan on GitHub
              </ExternalLink>
            </div>
          </div>
          <Item title="How memrynote started">
            The first line of memrynote was written in December 2025 to build the app Kaan wished
            existed: local-first, private by design, with no plugin maze and no cloud lock-in. It
            has shipped in the open ever since, with a public changelog and roadmap.
          </Item>
          <Item title="Team composition">
            memrynote is an independent, founder-run company with no outside investors directing the
            roadmap. Revenue comes only from optional sync plans, never from ads or user data.
          </Item>
          <div className="flex flex-wrap items-center gap-5">
            <ExternalLink href={GITHUB_URL} target="github">
              memrynote on GitHub
            </ExternalLink>
            <ExternalLink href={REDDIT_URL} target="reddit">
              r/MemryNote on Reddit
            </ExternalLink>
          </div>
        </div>
      </Section>

      <Section id="how-memrynote-works" title="How memrynote works" tinted>
        <div className="space-y-10">
          {HOW_IT_WORKS.map((step) => (
            <Item key={step.title} title={step.title}>
              {step.body}
            </Item>
          ))}
        </div>
      </Section>

      <Section id="key-facts" title="Key facts">
        <dl className="divide-y divide-border/70 border-y border-border/70">
          {KEY_FACTS.map((fact) => (
            <div key={fact.term} className="grid gap-1 py-4 sm:grid-cols-[200px_1fr] sm:gap-6">
              <dt className="font-medium text-ink">{fact.term}</dt>
              <dd className="leading-relaxed text-muted">{fact.detail}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="frequently-asked-questions" title="Frequently asked questions" tinted>
        <div className="space-y-10">
          {ABOUT_FAQS.map((faq) => (
            <Item key={faq.question} title={faq.question}>
              {faq.answer}
            </Item>
          ))}
        </div>
      </Section>
    </main>
  )
}
