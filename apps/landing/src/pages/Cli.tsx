import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Terminal, Download, ArrowRight, Zap, Braces, Lock, type LucideIcon } from 'lucide-react'
import { PageHead } from '@/components/shared/PageHead'
import { Container } from '@/components/layout/Container'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const
const DOCS_CLI_URL = 'https://docs.memrynote.com/user-guide/cli-reference'

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } }
}

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT_EXPO } }
}

// A prompt line ('$ …') renders the command; a plain line renders dimmed output.
type TermLine = { prompt: string } | { out: string }

function Term({ title, lines }: { title?: string; lines: TermLine[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-ink shadow-card">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        {title ? <span className="ms-3 font-mono text-xs text-white/40">{title}</span> : null}
      </div>
      <div className="overflow-x-auto p-4">
        <pre className="font-mono text-[13px] leading-relaxed">
          {lines.map((line) =>
            'prompt' in line ? (
              <div key={`p:${line.prompt}`} className="whitespace-pre text-white/90">
                <span className="text-terracotta">$ </span>
                {line.prompt}
              </div>
            ) : (
              <div key={`o:${line.out}`} className="whitespace-pre text-white/45">
                {line.out}
              </div>
            )
          )}
        </pre>
      </div>
    </div>
  )
}

interface UseCase {
  icon: LucideIcon
  title: string
  text: string
}

const USE_CASES: UseCase[] = [
  {
    icon: Zap,
    title: 'Automate',
    text: 'Fire notes, tasks, and journal entries from scripts, cron jobs, and keyboard shortcuts. Your vault, hands-free.'
  },
  {
    icon: Braces,
    title: 'Pipe & compose',
    text: 'Add --json to any command and pipe memrynote into jq, fzf, or your editor. It composes like every other Unix tool.'
  },
  {
    icon: Lock,
    title: 'Local & private',
    text: 'Every command runs against your local vault. No server round-trip, nothing leaves your machine.'
  }
]

const STEPS: { title: string; text: string }[] = [
  {
    title: 'Get memrynote for Desktop',
    text: 'The CLI ships inside the desktop app — no separate install, no package manager.'
  },
  {
    title: 'Enable it in Settings → Command Line',
    text: 'Toggle the command on and pick a default vault. It drops a memrynote shim on your PATH.'
  },
  {
    title: 'Run memrynote in any terminal',
    text: 'That’s it. Every command works against your default vault, or pass --vault to target another.'
  }
]

const EXAMPLES: { title: string; lines: TermLine[] }[] = [
  {
    title: 'notes & journal',
    lines: [
      { prompt: 'memrynote notes create --title "Standup"' },
      { out: 'Created note "Standup" (note_a1b2)' },
      { prompt: 'memrynote journal append --content "- shipped the CLI page"' },
      { out: 'Appended to 2026-07-03' }
    ]
  },
  {
    title: 'tasks',
    lines: [
      { prompt: 'memrynote tasks create "Review PR" --project Work' },
      { out: 'Created task "Review PR" (task_9f3c)' },
      { prompt: 'memrynote tasks list --status todo' },
      { out: '3 tasks · Review PR · Ship docs · Reply to Kaan' }
    ]
  },
  {
    title: 'scripting with --json',
    lines: [
      { prompt: 'memrynote --json tasks list | jq ".[].title"' },
      { out: '"Review PR"' },
      { out: '"Ship docs"' },
      { prompt: 'memrynote sync status' },
      { out: 'up to date · 2 devices · last sync 4s ago' }
    ]
  }
]

// The 21 top-level commands, mirrored from apps/cli/src/run.ts usage output.
const COMMANDS = [
  'vault',
  'notes',
  'folders',
  'properties',
  'folder-view',
  'tasks',
  'projects',
  'inbox',
  'journal',
  'tags',
  'settings',
  'locale',
  'reminders',
  'templates',
  'bookmarks',
  'saved-filters',
  'calendar',
  'sync',
  'agent',
  'graph',
  'search'
]

function DownloadCta() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
      <Link
        to="/download/desktop"
        className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 text-sm font-medium text-paper transition-colors hover:bg-ink/90"
      >
        <Download className="h-4 w-4" />
        Download for Desktop
      </Link>
      <a
        href={DOCS_CLI_URL}
        className="inline-flex items-center gap-2 rounded-full border border-border px-6 py-3 text-sm font-medium text-ink transition-colors hover:bg-paper-alt"
      >
        Read the CLI docs
        <ArrowRight className="h-4 w-4" />
      </a>
    </div>
  )
}

export function CliPage() {
  return (
    <main className="pt-24">
      <PageHead page="cli" />

      <section className="py-20">
        <Container size="md">
          <motion.div
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
            className="mb-12 text-center"
          >
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-terracotta/30 bg-terracotta/5 px-4 py-2 text-sm font-medium text-terracotta">
              <Terminal className="h-4 w-4" />
              Command Line
            </div>
            <h1 className="mb-6 font-serif text-5xl leading-[1.1] text-ink md:text-6xl lg:text-7xl">
              memrynote,
              <br />
              <span className="text-terracotta">from the terminal.</span>
            </h1>
            <p className="mx-auto max-w-2xl font-sans text-xl leading-relaxed text-muted">
              Anything you do in memrynote — notes, tasks, journal, calendar, sync — is scriptable
              from the command line. Local-first, JSON-native, yours to automate.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.15, ease: EASE_OUT_EXPO }}
            className="mx-auto max-w-2xl"
          >
            <Term
              title="memrynote"
              lines={[
                { prompt: 'memrynote notes create --title "Weekly review"' },
                { out: 'Created note "Weekly review" (note_7ac1)' },
                { prompt: 'memrynote --json tasks list --status todo' },
                { out: '[{ "title": "Ship the CLI page", "status": "todo" }]' }
              ]}
            />
            <div className="mt-8">
              <DownloadCta />
            </div>
          </motion.div>
        </Container>
      </section>

      <section className="py-8">
        <Container size="md">
          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
            className="grid gap-6 md:grid-cols-3"
          >
            {USE_CASES.map(({ icon: Icon, title, text }) => (
              <motion.div
                key={title}
                variants={fadeUp}
                className="rounded-2xl border border-border bg-card p-8"
              >
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                  <Icon className="h-6 w-6" strokeWidth={1.5} />
                </div>
                <h3 className="mb-3 font-serif text-2xl text-ink">{title}</h3>
                <p className="leading-relaxed text-muted">{text}</p>
              </motion.div>
            ))}
          </motion.div>
        </Container>
      </section>

      <section className="bg-paper-alt py-20">
        <Container size="md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
            className="mb-14"
          >
            <h2 className="mb-4 font-serif text-3xl text-ink md:text-4xl">
              Up and running in a minute
            </h2>
            <p className="max-w-2xl text-lg leading-relaxed text-muted">
              No brew, no npm. The CLI is bundled with the desktop app.
            </p>
          </motion.div>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
            className="grid gap-6 md:grid-cols-3"
          >
            {STEPS.map((step, i) => (
              <motion.div key={step.title} variants={fadeUp} className="flex flex-col">
                <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono text-sm text-paper">
                  {i + 1}
                </div>
                <h3 className="mb-2 font-serif text-xl text-ink">{step.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{step.text}</p>
              </motion.div>
            ))}
          </motion.div>
        </Container>
      </section>

      <section className="py-20">
        <Container size="md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
            className="mb-14"
          >
            <h2 className="mb-4 font-serif text-3xl text-ink md:text-4xl">See it in action</h2>
            <p className="max-w-2xl text-lg leading-relaxed text-muted">
              Real commands, real output. Every one has a --json twin for scripting.
            </p>
          </motion.div>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
            className="grid gap-6 md:grid-cols-3"
          >
            {EXAMPLES.map((example) => (
              <motion.div key={example.title} variants={fadeUp}>
                <Term title={example.title} lines={example.lines} />
              </motion.div>
            ))}
          </motion.div>
        </Container>
      </section>

      <section className="bg-paper-alt py-20">
        <Container size="md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
            className="mb-10"
          >
            <h2 className="mb-4 font-serif text-3xl text-ink md:text-4xl">
              21 commands, one vault
            </h2>
            <p className="max-w-2xl text-lg leading-relaxed text-muted">
              The whole app, addressable from the shell.
            </p>
          </motion.div>

          <div className="flex flex-wrap gap-2">
            {COMMANDS.map((command) => (
              <span
                key={command}
                className="rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-sm text-ink/80"
              >
                {command}
              </span>
            ))}
          </div>
        </Container>
      </section>

      <section className="py-24">
        <Container size="sm">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
            className="text-center"
          >
            <h2 className="mb-4 font-serif text-3xl text-ink">Bring your vault to the terminal</h2>
            <p className="mx-auto mb-8 max-w-lg text-lg leading-relaxed text-muted">
              Download memrynote, flip on the command line, and start scripting your second brain.
            </p>
            <DownloadCta />
          </motion.div>
        </Container>
      </section>
    </main>
  )
}
