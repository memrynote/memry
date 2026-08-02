import { Link } from 'react-router'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  FileText,
  GitBranch,
  History,
  Inbox,
  KeyRound,
  Layers,
  Link2,
  ListChecks,
  Lock,
  MessageSquare,
  PenLine,
  Quote,
  ScrollText,
  Server,
  ShieldCheck,
  Sliders,
  Sparkles,
  Terminal,
  WifiOff,
  X,
  type LucideIcon
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { FeatureHeroScreenshot } from '@/components/shared/FeatureHeroScreenshot'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: EASE_OUT_EXPO }
}

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } }
}

const fadeUpVariant = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE_OUT_EXPO } }
}

export function AIAgentFeaturePage() {
  return (
    <>
      <PageHead page="aiAgent" />
      <main>
        <AIAgentHero />
        <EverythingInOnePlace />
        <BackendsAndPermissions />
        <ApprovalShowcase />
        <LocalOnlyMode />
        <StructureSection />
        <WorksWithRest />
        <AgentUseCases />
        <MoreFeatures />
        <AgentFaq />
        <FinalCta />
      </main>
    </>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
      {children}
    </span>
  )
}

function AIAgentHero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-24">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.10),transparent_60%)]"
      />
      <Container size="md">
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="text-center"
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-terracotta/30 bg-terracotta/10 px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.28em] text-terracotta">
              <Sparkles className="h-3 w-3" strokeWidth={2} />
              AI Agent
            </span>
          </div>
          <h1 className="mt-5 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            Chat with your second brain.
            <br />
            <span className="italic text-terracotta">On your device.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            An optional AI agent that lives inside memrynote. Turn it on or off anytime.
            Local-first, BYOK, MCP-native. Your vault never leaves your machine with local models,
            and every write needs your nod.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-7" asChild>
              <Link to="/download/desktop">
                Download
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/features">
                All features
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="mt-14"
        >
          <HeroChatMock />
        </motion.div>
      </Container>
    </section>
  )
}

function HeroChatMock() {
  return (
    <FeatureHeroScreenshot
      screenshot="notes"
      alt="memrynote notes page showing a markdown note with properties, linked context, and vault structure"
      width={1232}
      height={870}
    />
  )
}

const ANCHOR_CARDS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: MessageSquare,
    title: 'Chat with citations',
    body: 'Every answer points back to the source notes. Click a citation, jump straight to the line.'
  },
  {
    icon: ShieldCheck,
    title: 'Approval-gated writes',
    body: 'The agent proposes the edit. You approve, decline, or always-allow for the conversation.'
  },
  {
    icon: KeyRound,
    title: 'BYOK providers',
    body: 'Bring your own Claude, Codex, Ollama, or OpenAI-compatible backend only if you want AI on. Keys stay in the OS keychain.'
  },
  {
    icon: Server,
    title: 'MCP-native vault',
    body: 'One localhost Vault MCP server runs in memrynote. External MCP clients can read it. Writes still need you.'
  }
]

function EverythingInOnePlace() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Architecture, not magic</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for trust.
            <br />
            Not for autoplay.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            We built the agent the way we would want one. AI stays optional, open backends and local
            options are first-class, and there is a stop button before any write.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {ANCHOR_CARDS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="group flex flex-col rounded-2xl border border-border/60 bg-card p-6 shadow-card transition-shadow hover:shadow-elevated"
            >
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-5 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

function BackendsAndPermissions() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Backends · MCP · Permissions</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Your model.
            <br />
            <span className="italic text-terracotta">Your server. Your audit log.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Pick a backend. Plug into the local Vault MCP server. Watch every permission decision in
            a visible audit log.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          <BackendsCard />
          <MCPServerCard />
          <AuditLogCard />
        </div>
      </Container>
    </section>
  )
}

function ShowcaseCard({
  label,
  title,
  body,
  children
}: {
  label: string
  title: string
  body: string
  children: React.ReactNode
}) {
  return (
    <motion.article
      {...fadeUp}
      className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-card"
    >
      <div className="border-b border-border/40 bg-paper-alt/60 px-6 py-5">
        <Eyebrow>{label}</Eyebrow>
        <h3 className="mt-2 font-serif text-2xl text-ink">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      </div>
      <div className="flex-1 px-6 py-7">{children}</div>
    </motion.article>
  )
}

const BACKENDS: {
  name: string
  sub: string
  icon: LucideIcon
  tone: 'terracotta' | 'sage' | 'amber' | 'ink'
}[] = [
  { name: 'Claude CLI', sub: 'Anthropic, via local CLI', icon: Terminal, tone: 'terracotta' },
  { name: 'Codex CLI', sub: 'OpenAI Codex, first-class', icon: Terminal, tone: 'ink' },
  { name: 'Ollama', sub: 'Local models, zero cloud', icon: Cpu, tone: 'sage' },
  { name: 'OpenAI-compatible', sub: 'vLLM, LM Studio, custom', icon: Server, tone: 'amber' }
]

const BACKEND_TONE: Record<'terracotta' | 'sage' | 'amber' | 'ink', string> = {
  terracotta: 'bg-terracotta/10 text-terracotta',
  sage: 'bg-sage/12 text-sage',
  amber: 'bg-amber-500/15 text-amber-700',
  ink: 'bg-ink/10 text-ink'
}

function BackendsCard() {
  return (
    <ShowcaseCard
      label="BYOK backends"
      title="Bring your own model."
      body="Switch providers per conversation. Settings persist with the chat, not the composer."
    >
      <ul className="grid grid-cols-2 gap-2.5">
        {BACKENDS.map((b) => (
          <li
            key={b.name}
            className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-paper p-3"
          >
            <span
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-lg',
                BACKEND_TONE[b.tone]
              )}
            >
              <b.icon className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono-accent text-[12px] text-ink">{b.name}</p>
              <p className="truncate text-[11px] text-muted">{b.sub}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 rounded-lg bg-paper-alt/60 px-3 py-2 font-mono-accent text-[11px] text-muted">
        Keys live in the OS keychain. Never bundled, never synced.
      </p>
    </ShowcaseCard>
  )
}

function MCPServerCard() {
  return (
    <ShowcaseCard
      label="Vault MCP server"
      title="One server. Many clients."
      body="memrynote runs a localhost MCP server. Claude CLI, Codex CLI, and your own tools can connect."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-4">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-sage">
            <span className="h-2 w-2 rounded-full bg-sage motion-safe:animate-pulse" />
            Running · localhost:7421
          </span>
          <span className="font-mono-accent text-[10px] uppercase tracking-[0.2em] text-muted">
            Read-only default
          </span>
        </div>
        <ul className="mt-4 space-y-2 text-[13px]">
          <li className="flex items-center justify-between gap-3 rounded-lg bg-paper-alt/60 px-3 py-2">
            <span className="font-mono-accent text-ink/85">read_note</span>
            <span className="font-mono-accent text-[11px] text-sage">allowed</span>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-lg bg-paper-alt/60 px-3 py-2">
            <span className="font-mono-accent text-ink/85">search_vault</span>
            <span className="font-mono-accent text-[11px] text-sage">allowed</span>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-lg bg-paper-alt/60 px-3 py-2">
            <span className="font-mono-accent text-ink/85">write_note</span>
            <span className="font-mono-accent text-[11px] text-amber-700">needs approval</span>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-lg bg-paper-alt/60 px-3 py-2">
            <span className="font-mono-accent text-ink/85">delete_note</span>
            <span className="font-mono-accent text-[11px] text-amber-700">needs approval</span>
          </li>
        </ul>
      </div>
      <p className="mt-5 text-[12px] text-muted">
        External MCP clients are read-only by default. Writes route through an active memrynote
        Agent conversation.
      </p>
    </ShowcaseCard>
  )
}

const AUDIT_LOG = [
  { time: '14:02', who: 'Claude CLI', action: 'read', target: '[[summary-2026]]', tone: 'sage' },
  {
    time: '14:02',
    who: 'memrynote Agent',
    action: 'wrote',
    target: '[[summary-2026]]',
    tone: 'terracotta'
  },
  { time: '13:58', who: 'Codex CLI', action: 'searched', target: '"pkm"', tone: 'sage' },
  { time: '13:51', who: 'You', action: 'declined', target: 'delete [[draft-old]]', tone: 'amber' },
  {
    time: '13:44',
    who: 'memrynote Agent',
    action: 'read',
    target: '[[journal/2026-05-15]]',
    tone: 'sage'
  }
] as const

const LOG_TONE: Record<'sage' | 'terracotta' | 'amber', string> = {
  sage: 'text-sage',
  terracotta: 'text-terracotta',
  amber: 'text-amber-700'
}

function AuditLogCard() {
  return (
    <ShowcaseCard
      label="Permission audit log"
      title="Every read. Every write."
      body="A persistent log of what the agent and connected clients did, with one-tap revoke."
    >
      <ul className="overflow-hidden rounded-xl border border-border/60 bg-paper">
        {AUDIT_LOG.map((row, i) => (
          <li
            key={`${row.time}-${row.who}`}
            className={cn(
              'grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-[13px]',
              i !== AUDIT_LOG.length - 1 && 'border-b border-border/40'
            )}
          >
            <span className="font-mono-accent text-[11px] text-muted">{row.time}</span>
            <span className="truncate">
              <span className="font-medium text-ink">{row.who}</span>{' '}
              <span className={LOG_TONE[row.tone]}>{row.action}</span>{' '}
              <span className="text-muted">{row.target}</span>
            </span>
            <span className="font-mono-accent text-[10px] uppercase tracking-[0.2em] text-muted">
              {row.tone === 'amber' ? 'Declined' : 'Allowed'}
            </span>
          </li>
        ))}
      </ul>
    </ShowcaseCard>
  )
}

function ApprovalShowcase() {
  return (
    <section className="relative">
      <div className="h-[80px] bg-gradient-to-b from-paper to-dark" aria-hidden />
      <div className="zone-dark py-24 md:py-28">
        <Container>
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-terracotta/30 bg-terracotta/10 px-3 py-1 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-terracotta">
              <ShieldCheck className="h-3 w-3" />
              Approval flow
            </span>
            <h2 className="mt-4 font-serif text-3xl font-normal leading-tight text-ink-inverted md:text-5xl">
              Diff first.
              <br />
              <span className="italic text-terracotta">Write only on approval.</span>
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-dark-muted">
              When the agent wants to edit a note, you see the exact diff first. Approve, decline,
              or hand it the keys for the conversation.
            </p>
          </motion.div>

          <div className="mt-14 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <ApprovalCardLarge />
            <div className="grid gap-5">
              <ConversationSettingsCard />
              <ConnectedAgentsCard />
            </div>
          </div>
        </Container>
      </div>
    </section>
  )
}

function ApprovalCardLarge() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-dark-border bg-dark-surface p-7 shadow-card md:p-9"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-dark-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-terracotta" />
          Pending write
        </span>
        <span className="font-mono-accent text-[10px] uppercase tracking-[0.2em] text-dark-muted">
          conversation · pkm-summary
        </span>
      </div>
      <h3 className="mt-3 font-serif text-2xl text-ink-inverted">
        Update <span className="font-mono-accent text-terracotta">[[reading-2026]]</span>
      </h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-dark-muted">
        The agent proposes three line changes. Nothing has touched disk.
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-dark-border bg-black/30 font-mono-accent text-[13px]">
        <div className="flex items-center justify-between border-b border-dark-border px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-dark-muted">
          <span>reading-2026.md</span>
          <span>+2 / -1</span>
        </div>
        <div className="bg-rose-500/15 px-4 py-1.5 text-rose-300">
          <span className="me-2">-</span>3. Read more PKM books this year
        </div>
        <div className="bg-sage/15 px-4 py-1.5 text-sage">
          <span className="me-2">+</span>3. Build a personal slip-box from PKM reading
        </div>
        <div className="bg-sage/15 px-4 py-1.5 text-sage">
          <span className="me-2">+</span>4. Linked: [[zettelkasten-method]], [[linked-thought]]
        </div>
      </div>

      <label className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-dark-border bg-black/20 px-4 py-3 text-[13px] text-ink-inverted/90">
        <span className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-terracotta" />
          Always allow writes in this conversation
        </span>
        <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-terracotta/40">
          <span className="absolute end-0.5 h-4 w-4 rounded-full bg-terracotta shadow" />
        </span>
      </label>

      <div className="mt-5 flex items-center justify-end gap-2.5">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-dark-border bg-transparent px-4 py-2 text-[13px] font-medium text-dark-muted hover:text-ink-inverted"
        >
          <X className="h-4 w-4" strokeWidth={2} />
          Decline
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full bg-terracotta px-4 py-2 text-[13px] font-medium text-paper"
        >
          <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
          Approve write
        </button>
      </div>
    </motion.article>
  )
}

function ConversationSettingsCard() {
  return (
    <motion.article
      {...fadeUp}
      transition={{ ...fadeUp.transition, delay: 0.1 }}
      className="rounded-2xl border border-dark-border bg-dark-surface p-6 shadow-card"
    >
      <span className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-dark-muted">
        Conversation settings
      </span>
      <h3 className="mt-2 font-serif text-xl text-ink-inverted">Persist with the chat.</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-dark-muted">
        Provider, model, reasoning level, and temperature live on the conversation, not the
        composer.
      </p>

      <ul className="mt-5 space-y-3 text-[13px] text-ink-inverted/90">
        <li className="flex items-center justify-between gap-3">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-dark-muted">
            Provider
          </span>
          <span className="rounded-md bg-terracotta/15 px-2 py-0.5 font-mono-accent text-terracotta">
            Claude CLI
          </span>
        </li>
        <li className="flex items-center justify-between gap-3">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-dark-muted">
            Model
          </span>
          <span className="font-mono-accent">claude-opus-4-7</span>
        </li>
        <li className="flex items-center justify-between gap-3">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-dark-muted">
            Reasoning
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-6 rounded-full bg-terracotta" />
            <span className="h-1.5 w-6 rounded-full bg-terracotta" />
            <span className="h-1.5 w-6 rounded-full bg-terracotta/30" />
            <span className="ms-1 font-mono-accent text-[11px] text-dark-muted">medium</span>
          </span>
        </li>
        <li className="flex items-center justify-between gap-3">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-dark-muted">
            Temperature
          </span>
          <span className="flex items-center gap-1.5">
            <span className="relative inline-block h-1.5 w-24 rounded-full bg-dark-border">
              <span className="absolute inset-y-0 start-0 w-[35%] rounded-full bg-terracotta" />
            </span>
            <span className="font-mono-accent text-[11px] text-dark-muted">0.35</span>
          </span>
        </li>
      </ul>
    </motion.article>
  )
}

const clients = [
  { name: 'Claude CLI', scope: 'read · write (this convo)', tone: 'terracotta' },
  { name: 'Codex CLI', scope: 'read only', tone: 'sage' },
  { name: 'Ollama (local)', scope: 'read only', tone: 'sage' }
] as const

const dot: Record<'terracotta' | 'sage', string> = {
  terracotta: 'bg-terracotta',
  sage: 'bg-sage'
}

function ConnectedAgentsCard() {
  return (
    <motion.article
      {...fadeUp}
      transition={{ ...fadeUp.transition, delay: 0.18 }}
      className="rounded-2xl border border-dark-border bg-dark-surface p-6 shadow-card"
    >
      <span className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-dark-muted">
        Connected MCP clients
      </span>
      <h3 className="mt-2 font-serif text-xl text-ink-inverted">Three agents, scoped.</h3>
      <ul className="mt-5 space-y-2.5 text-[13px]">
        {clients.map((c) => (
          <li
            key={c.name}
            className="flex items-center justify-between gap-3 rounded-xl border border-dark-border bg-black/20 px-3 py-2.5"
          >
            <span className="flex items-center gap-2.5 text-ink-inverted/90">
              <span className={cn('h-1.5 w-1.5 rounded-full', dot[c.tone])} />
              <span className="font-medium">{c.name}</span>
            </span>
            <span className="font-mono-accent text-[11px] text-dark-muted">{c.scope}</span>
          </li>
        ))}
      </ul>
    </motion.article>
  )
}

function LocalOnlyMode() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1.1fr_1fr]">
          <motion.div {...fadeUp}>
            <Eyebrow>Local-only mode</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
              Run a local model.
              <br />
              <span className="italic text-terracotta">Vault never leaves your machine.</span>
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              Pair memrynote with Ollama, llama.cpp, MLX, or vLLM when you want AI on. Switch one
              toggle and the agent stops talking to any network. Inference is yours.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {['Ollama', 'llama.cpp', 'MLX', 'vLLM'].map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-2 rounded-full border border-sage/30 bg-sage/12 px-3 py-1.5 text-sm text-sage shadow-sm"
                >
                  <Cpu className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {name}
                </span>
              ))}
            </div>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.1 }}
            className="rounded-2xl border border-border/60 bg-card p-7 shadow-card md:p-9"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 rounded-full border border-sage/30 bg-sage/12 px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.2em] text-sage">
                <span className="h-1.5 w-1.5 rounded-full bg-sage motion-safe:animate-pulse" />
                Local mode active
              </span>
              <span className="inline-flex items-center gap-1.5 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                <WifiOff className="h-3.5 w-3.5" strokeWidth={1.8} />0 outbound
              </span>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border/60 bg-paper-alt/50 p-4">
                <p className="font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted">
                  Inference
                </p>
                <p className="mt-2 font-mono-accent text-[13px] text-ink">localhost:11434</p>
                <p className="mt-1 text-[12px] text-sage">ollama · llama3.1:70b</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-paper-alt/50 p-4">
                <p className="font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted">
                  Vault
                </p>
                <p className="mt-2 font-mono-accent text-[13px] text-ink">~/memrynote/Vault</p>
                <p className="mt-1 text-[12px] text-sage">on-device only</p>
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-xl border border-border/60 bg-dark px-4 py-3 font-mono-accent text-[12px] leading-relaxed text-paper">
              <span className="text-terracotta-glow">$</span> netstat -an | grep ESTABLISHED
              <br />
              <span className="text-sage">— no remote endpoints —</span>
            </div>
            <p className="mt-4 rounded-lg bg-paper-alt/60 px-3 py-2 font-mono-accent text-[11px] text-muted">
              The same approval gate still guards every write. Local does not mean unattended.
            </p>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}

const STRUCTURE_CARDS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: History,
    title: 'Settings persistence',
    body: 'Provider, model, reasoning level, and temperature stay on the conversation. Pick up where you left off.'
  },
  {
    icon: Server,
    title: 'MCP discoverability',
    body: 'The Vault MCP server exposes a clear capability list. Any compliant client can list, scope, and call.'
  },
  {
    icon: Lock,
    title: 'Read-only by default',
    body: 'External MCP clients get read access only. Writes require an active memrynote Agent conversation and your approval.'
  },
  {
    icon: ScrollText,
    title: 'Approval audit log',
    body: 'Every read, write, and decline lands in a persistent log. Revoke a client in one tap.'
  },
  {
    icon: Quote,
    title: 'Cite-with-context',
    body: 'Answers ship with [[wiki-link]] citations and the surrounding line. No hallucinated sources.'
  },
  {
    icon: ShieldCheck,
    title: 'Per-vault permissions',
    body: 'Different vaults can grant different scopes. Work vault stays sealed off from your personal one.'
  }
]

function StructureSection() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Structure</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Six guarantees.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            The hard architectural commitments behind the chat window.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {STRUCTURE_CARDS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const INTEGRATIONS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Inbox,
    title: 'Reads the vault',
    body: 'Inbox, journal, notes, tasks — all reachable through the local Vault MCP server.'
  },
  {
    icon: PenLine,
    title: 'Writes with approval',
    body: 'Drafts edits as diffs you can accept. Nothing touches a file before you say yes.'
  },
  {
    icon: ShieldCheck,
    title: 'Never leaves your device',
    body: 'With AI on and a local model selected, your vault and prompts stay on-machine. No cloud round-trips.'
  }
]

function WorksWithRest() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Works with the rest of memrynote.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            The agent is not a separate app. It is a layer over the same vault that powers your
            inbox, journal, notes, and tasks.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-3"
        >
          {INTEGRATIONS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sage/12 text-sage">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const USE_CASES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: PenLine,
    title: 'Drafters',
    body: 'Outline, rewrite, polish. The agent reads your prior notes and matches your voice.'
  },
  {
    icon: FileText,
    title: 'Researchers',
    body: 'Ask a question. Get cited [[wiki-links]] back. Jump straight to the source line.'
  },
  {
    icon: ListChecks,
    title: 'Builders',
    body: 'Draft specs, ADRs, runbooks. The agent proposes a diff; you approve the change.'
  },
  {
    icon: Sparkles,
    title: 'ADHD brains',
    body: 'Capture now, organize later. The agent suggests where it belongs after the fact.'
  }
]

function AgentUseCases() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Use cases</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for the way you actually work.
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {USE_CASES.map((u) => (
            <motion.article
              key={u.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <u.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-lg text-ink">{u.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{u.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const MORE_FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Link2,
    title: 'Citation hyperlinks',
    body: 'Every cited [[wiki-link]] jumps to the source note, scrolled to the line.'
  },
  {
    icon: GitBranch,
    title: 'Write preview diff',
    body: 'See every proposed line change before disk hears a thing.'
  },
  {
    icon: History,
    title: 'Conversation history',
    body: 'Threads persist with their provider, model, and reasoning settings.'
  },
  {
    icon: ShieldCheck,
    title: 'Per-vault permissions',
    body: 'Different vaults, different scopes. Work and personal stay separate.'
  },
  {
    icon: Layers,
    title: 'MCP server logs',
    body: 'Inspect what each connected client called, when, and how.'
  },
  {
    icon: Lock,
    title: 'BYOK encryption',
    body: 'Provider keys live in the OS keychain. Never bundled, never synced to our servers.'
  }
]

function MoreFeatures() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>And more</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Wait — there&apos;s more.
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {MORE_FEATURES.map((m) => (
            <motion.article
              key={m.title}
              variants={fadeUpVariant}
              className="flex items-start gap-4 rounded-2xl border border-border/55 bg-card/60 p-5"
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-terracotta/10 text-terracotta">
                <m.icon className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <div>
                <p className="font-serif text-base text-ink">{m.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{m.body}</p>
              </div>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const AGENT_FAQ = [
  {
    question: 'Do I need an API key?',
    answer:
      'Only if you want to use a hosted provider like Claude or Codex. Bring your own key and memrynote stores it in your OS keychain. Or skip the keys entirely and run a local model with Ollama, llama.cpp, MLX, or vLLM.'
  },
  {
    question: 'Can I turn AI off?',
    answer:
      'Yes. AI is optional and can be turned on or off from settings. If you leave it off, your vault still works as a local-first notes, tasks, journal, inbox, and calendar app.'
  },
  {
    question: 'Is my vault sent to the cloud?',
    answer:
      'Not unless you pick a hosted backend and approve the call. With a local model selected, the agent talks to localhost only — your vault, your prompts, and your responses all stay on-device.'
  },
  {
    question: 'Can the agent edit my notes?',
    answer:
      'Only with your approval. Every write is shown as a diff first. You can decline per change, or toggle always-allow for the active conversation. The full history lives in the audit log.'
  },
  {
    question: 'How do MCP clients work?',
    answer:
      'memrynote runs one localhost Vault MCP server. Any compliant MCP client — Claude CLI, Codex CLI, your own tools — can connect, list capabilities, and read. External clients are read-only by default. Writes route through an active memrynote Agent conversation and your approval.'
  }
]

function AgentFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Agent, answered.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {AGENT_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`agent-faq-${i}`}
                className="rounded-none border-b border-border/55 bg-transparent px-0 last:border-0 data-[state=open]:bg-transparent"
              >
                <AccordionTrigger className="py-5 text-left font-serif text-lg text-ink hover:text-terracotta hover:no-underline">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="pb-5 text-[17px] font-sans leading-relaxed text-muted max-w-[92%]">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </Container>
    </section>
  )
}

function FinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            Your second brain.{' '}
            <span className="italic text-terracotta">Your model. Your approval.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Local-first. BYOK. MCP-native. Optional, and off until you turn it on.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-8" asChild>
              <Link to="/download/desktop">
                Download
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-8 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/features">
                See all features
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
