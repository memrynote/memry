import { Link } from 'react-router'
import { motion } from 'motion/react'
import { ArrowRight, Eye, EyeOff, HardDrive, KeyRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { DownloadPill } from '@/components/shared/DownloadCTA'
import { Faq } from '@/components/site/Faq'
import { FinalCta } from '@/components/site/FinalCta'
import { PageHero } from '@/components/site/PageHero'
import { SectionTitle } from '@/components/site/primitives'
import { getPageTint } from '@/lib/site-tints'
import { trackLandingEvent } from '@/lib/analytics'

const EASE = [0.16, 1, 0.3, 1] as const

const RISE = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' } as const,
  transition: { duration: 0.8, ease: EASE }
}

// What the sync server holds in readable form. Item ids are sent in the clear
// (docs/protocol/04-record-envelope.md §4.6), and tag and folder ids are their
// names and paths (docs/protocol/13-payload-schemas.md §13.6).
const SERVER_SEES = [
  'Your account email and the devices you linked.',
  'For each synced item: its ID, its type (note, task, journal day, and so on), its size, when it changed, and which device signed it.',
  'Your tag names and folder paths, because sync uses them as item IDs.',
  'How much storage you use, for your plan.'
] as const

const SERVER_CANNOT_READ = [
  'Note titles and bodies.',
  'Journal entries.',
  'Tasks, projects, and every task field.',
  'Properties and their values.',
  'Attachments, such as PDFs and images.',
  'Vault names.',
  'Agent Chat conversations.'
] as const

interface KeyFact {
  icon: LucideIcon
  title: string
  text: string
}

const KEY_FACTS: readonly KeyFact[] = [
  {
    icon: KeyRound,
    title: 'A recovery phrase only you hold',
    text: 'When you create an account, memrynote creates a 24-word recovery phrase on your device and asks you to confirm it. memrynote derives your keys from it with Argon2id. We never receive the phrase.'
  },
  {
    icon: Eye,
    title: 'Encrypted before upload',
    text: 'Every note, task, journal day, and attachment is encrypted on your device with XChaCha20-Poly1305. Each device signs what it uploads with its own Ed25519 key, so the server cannot change an item without the signature failing.'
  },
  {
    icon: HardDrive,
    title: 'No account for local use',
    text: 'Without sync, nothing leaves your computer. Your notes are Markdown files in a folder you choose, and the app works offline.'
  }
]

const FALLS_SHORT = [
  'Notes on your computer are plain Markdown files. memrynote does not encrypt them on disk, so turn on your system disk encryption: FileVault on a Mac, BitLocker on Windows, or LUKS on Linux.',
  'We cannot reset your recovery phrase. If you lose it and every signed-in device, nobody can decrypt your synced notes again. The files on your computer stay readable.',
  'The server can see tag names, folder paths, item sizes, and change times, as listed above.',
  'Sync runs only through our hosted service. A self-hosted sync server is planned, not available.',
  'Sync is paid. The local app is free, and sync starts at $5 a month.',
  'The iPhone app is in TestFlight beta; iPad support is in development. There is no Android or web app, and no sharing between accounts.'
] as const

const ENCRYPTED_NOTES_FAQ = [
  {
    question: 'Is memrynote end-to-end encrypted?',
    answer:
      'Yes. Sync is always end-to-end encrypted. Notes, journal entries, tasks, and attachments are encrypted on your device with XChaCha20-Poly1305 before upload, and the server stores only ciphertext plus the metadata it needs to route it.'
  },
  {
    question: 'Can memrynote read my notes?',
    answer:
      'No. The keys that decrypt your notes come from your recovery phrase and stay on your devices. The server can see item IDs, types, sizes, change times, tag names, and folder paths, but not the content of any note.'
  },
  {
    question: 'What happens if I lose my recovery phrase?',
    answer:
      'While one of your devices is still signed in, you can keep using it, and on a sync plan you can link new devices from it. If you lose the phrase and every signed-in device, nobody can decrypt your synced data, including us. The Markdown files on your computer stay readable.'
  },
  {
    question: 'Do I need an account to use memrynote?',
    answer:
      'No. The app is free on your computer with no account, and nothing leaves your device. You need an account and a paid plan only for sync between devices.'
  },
  {
    question: 'Are my notes encrypted on my computer?',
    answer:
      'No. Notes are plain Markdown files so any editor can open them. Protect them with your system disk encryption, such as FileVault, BitLocker, or LUKS.'
  },
  {
    question: 'Is memrynote open source?',
    answer:
      'Yes. The code, including the sync server, is public at github.com/memrynote/memry under AGPL-3.0, so you can check how encryption works.'
  }
] as const

function ListCard({
  icon: Icon,
  title,
  items
}: {
  icon: LucideIcon
  title: string
  items: readonly string[]
}) {
  return (
    <motion.div {...RISE} className="rounded-3xl border border-border bg-card p-7 md:p-9">
      <div className="mb-5 flex items-center gap-3">
        <Icon className="h-5 w-5 text-terracotta" strokeWidth={1.75} aria-hidden />
        <h3 className="font-serif text-2xl text-ink">{title}</h3>
      </div>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3 text-base leading-relaxed text-muted">
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta/70" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </motion.div>
  )
}

function InlineLink({ to, event, children }: { to: string; event: string; children: string }) {
  return (
    <Link
      to={to}
      onClick={() => trackLandingEvent('landing_nav_click', event)}
      className="inline-flex items-center gap-1.5 rounded-sm font-medium text-terracotta hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
    >
      {children}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Link>
  )
}

export function EncryptedNotesAppPage() {
  return (
    <>
      <PageHead page="encryptedNotesApp" faqs={ENCRYPTED_NOTES_FAQ} />
      <main>
        <PageHero
          tint={getPageTint('encryptedNotesApp')}
          eyebrow="Encrypted notes app"
          title={
            <>
              Private notes the server{' '}
              <span className="italic text-terracotta">can&apos;t read.</span>
            </>
          }
          sub="memrynote is a notes app with end-to-end encryption. Your notes are Markdown files on your computer, and sync uploads only ciphertext that we have no key to open."
          actions={
            <div className="flex flex-col items-center gap-3">
              <DownloadPill location="encrypted-notes-hero" />
              <p className="text-[13px] text-muted">Free on your device. No account needed.</p>
            </div>
          }
        />

        <section className="py-20 md:py-28">
          <Container size="md">
            <SectionTitle
              eyebrow="What the server holds"
              title="What we can see, and what we can't"
              sub="A sync service always knows something about your data. This is the full list for memrynote, taken from the published sync protocol."
            />
            <div className="grid gap-6 md:grid-cols-2">
              <ListCard icon={Eye} title="The server can see" items={SERVER_SEES} />
              <ListCard icon={EyeOff} title="The server cannot read" items={SERVER_CANNOT_READ} />
            </div>
          </Container>
        </section>

        <section className="bg-paper-alt py-20 md:py-28">
          <Container size="md">
            <SectionTitle
              eyebrow="How it works"
              title="Your keys stay on your devices"
              sub="Sign-in uses an email code or Google. That unlocks your account, not your notes."
            />
            <div className="grid gap-6 md:grid-cols-3">
              {KEY_FACTS.map((fact) => (
                <motion.div
                  key={fact.title}
                  {...RISE}
                  className="rounded-3xl border border-border bg-card p-7"
                >
                  <fact.icon
                    className="mb-4 h-6 w-6 text-terracotta"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  <h3 className="mb-2 font-serif text-xl text-ink">{fact.title}</h3>
                  <p className="text-[15px] leading-relaxed text-muted">{fact.text}</p>
                </motion.div>
              ))}
            </div>
            <p className="mt-10 text-center text-base text-muted">
              <InlineLink to="/security" event="security:encrypted-notes">
                Read the security architecture
              </InlineLink>
            </p>
          </Container>
        </section>

        <section className="py-20 md:py-28">
          <Container size="md">
            <SectionTitle
              eyebrow="Before you switch"
              title="Where memrynote falls short"
              sub="We make memrynote, so here is what it does not do yet."
            />
            <motion.ul {...RISE} className="mx-auto max-w-3xl space-y-4">
              {FALLS_SHORT.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 text-base leading-relaxed text-muted md:text-lg"
                >
                  <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta/70" />
                  <span>{item}</span>
                </li>
              ))}
            </motion.ul>
            <p className="mx-auto mt-10 max-w-3xl text-base leading-relaxed text-muted">
              Comparing apps? Our roundup of{' '}
              <Link
                to="/blog/best-end-to-end-encrypted-notes-apps"
                className="rounded-sm font-medium text-terracotta hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
              >
                end-to-end encrypted notes apps
              </Link>{' '}
              checks Joplin, Anytype, Notesnook, Standard Notes, Obsidian, and Proton Docs the same
              way, including where each falls short.
            </p>
          </Container>
        </section>

        <Faq
          title={
            <>
              Encryption <span className="italic text-terracotta">questions.</span>
            </>
          }
          items={ENCRYPTED_NOTES_FAQ}
        />

        <FinalCta
          title={
            <>
              Your notes, <span className="italic text-terracotta">readable only by you.</span>
            </>
          }
          sub="Start in the free local app. Turn on encrypted sync when you want your notes on a second device."
          location="encrypted-notes-final"
          secondary={{
            label: 'See pricing',
            to: '/pricing',
            event: 'pricing:encrypted-notes-final'
          }}
        />
      </main>
    </>
  )
}
