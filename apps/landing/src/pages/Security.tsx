import { motion } from 'motion/react'
import { PageHead } from '@/components/shared/PageHead'
import {
  HardDrive,
  Lock,
  Brain,
  RefreshCw,
  Github,
  Mail,
  Shield,
  FileText,
  Eye,
  EyeOff,
  QrCode
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import type { LucideIcon } from 'lucide-react'

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } }
}

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT_EXPO } }
}

interface SecuritySection {
  icon: LucideIcon
  title: string
  description: string
  details: string[]
}

const SECURITY_SECTIONS: SecuritySection[] = [
  {
    icon: HardDrive,
    title: 'Local-first storage',
    description:
      'Your notes are plain Markdown files stored in a folder you choose. No proprietary database, no vendor lock-in.',
    details: [
      'Plain .md files on your filesystem',
      'Pick any folder — iCloud, Dropbox, or fully offline',
      'SQLite for metadata, FTS5 for search',
      'Zero cloud dependency for core functionality'
    ]
  },
  {
    icon: Lock,
    title: 'End-to-end encryption',
    description:
      'When you sync, every byte is encrypted before it leaves your device. We cannot read your data. Nobody can.',
    details: [
      'libsodium (XChaCha20-Poly1305) for all sync traffic',
      'At-rest encryption for local database',
      'Keys derived on-device, never transmitted',
      'OS keychain for credential storage'
    ]
  },
  {
    icon: EyeOff,
    title: 'Minimal telemetry',
    description:
      'We collect anonymous usage analytics to improve the app. That is it. Your content never leaves your device.',
    details: [
      'Anonymous feature-usage counters only',
      'No content, filenames, or metadata collected',
      'No third-party trackers or ad networks',
      'Telemetry can be fully disabled in settings'
    ]
  },
  {
    icon: Brain,
    title: 'On-device AI',
    description:
      'AI is optional and can be turned on or off. With a local model, your notes are never sent to OpenAI, Google, or anyone else.',
    details: [
      'AI can be disabled fully in settings',
      'Local inference via on-device model',
      'No API calls to external AI providers',
      'Context stays in your process memory',
      'Works fully offline'
    ]
  },
  {
    icon: RefreshCw,
    title: 'Encrypted sync',
    description:
      'Paid multi-device sync uses CRDTs for conflict-free merging. Devices approve each other with QR codes, and vault keys stay off the server.',
    details: [
      'CRDT-based sync via Yjs',
      'Conflict-free, deterministic merging',
      'QR code device linking',
      'Incremental sync with per-field vector clocks'
    ]
  },
  {
    icon: Github,
    title: 'Open source',
    description:
      'memrynote will be fully open source. Audit the code, verify our claims, build on top of it.',
    details: [
      'Repository coming soon at github.com/memrynote/memry',
      'AGPL-3.0 license',
      'Reproducible builds planned',
      'Security audits welcome'
    ]
  }
]

function SecurityCard({ section }: { section: SecuritySection }) {
  const Icon = section.icon
  return (
    <motion.div
      variants={fadeUp}
      className="group relative p-8 rounded-2xl border border-border bg-card hover:shadow-card transition-shadow"
    >
      <div className="flex items-center gap-4 mb-5">
        <div className="w-12 h-12 rounded-xl bg-sage/10 flex items-center justify-center">
          <Icon className="w-6 h-6 text-sage" strokeWidth={1.5} />
        </div>
        <h3 className="font-serif text-2xl text-ink">{section.title}</h3>
      </div>
      <p className="text-muted leading-relaxed mb-6">{section.description}</p>
      <ul className="space-y-3">
        {section.details.map((detail) => (
          <li key={detail} className="flex items-start gap-3 text-sm text-ink/75">
            <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-sage/60 flex-shrink-0" />
            {detail}
          </li>
        ))}
      </ul>
    </motion.div>
  )
}

function Principle({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <motion.div variants={fadeUp} className="flex items-start gap-4">
      <div className="w-10 h-10 rounded-lg bg-terracotta/8 flex items-center justify-center flex-shrink-0">
        <Icon className="w-5 h-5 text-terracotta" strokeWidth={1.5} />
      </div>
      <div>
        <h4 className="font-serif text-lg text-ink mb-1">{title}</h4>
        <p className="text-sm text-muted leading-relaxed">{text}</p>
      </div>
    </motion.div>
  )
}

export function SecurityPage() {
  return (
    <main className="pt-24">
      <PageHead page="security" />
      <section className="py-20">
        <Container size="md">
          <motion.div
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
            className="text-center mb-8"
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-sage/30 bg-sage/5 text-sage text-sm font-medium mb-8">
              <Shield className="w-4 h-4" />
              Security & Privacy
            </div>
            <h1 className="font-serif text-5xl md:text-6xl lg:text-7xl text-ink mb-6 leading-[1.1]">
              Your data is yours.
              <br />
              <span className="text-terracotta">Period.</span>
            </h1>
            <p className="text-xl text-muted font-sans max-w-2xl mx-auto leading-relaxed">
              memrynote is local-first, end-to-end encrypted, and open source. We built it for
              people who take ownership of their data seriously.
            </p>
          </motion.div>
        </Container>
      </section>

      <section className="py-4 pb-20">
        <Container size="md">
          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-40px' }}
            className="grid gap-3 sm:grid-cols-3 mb-20"
          >
            <Principle
              icon={Eye}
              title="Zero-knowledge"
              text="We cannot see your notes, even if compelled. The math guarantees it."
            />
            <Principle
              icon={FileText}
              title="Plain files"
              text="Standard Markdown on your disk. No proprietary format, no lock-in."
            />
            <Principle
              icon={QrCode}
              title="Sync without vault-key custody"
              text="Sync accounts manage billing and devices. Vault keys stay on your devices."
            />
          </motion.div>
        </Container>
      </section>

      <section className="py-20 bg-paper-alt">
        <Container size="md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
            className="mb-14"
          >
            <h2 className="font-serif text-3xl md:text-4xl text-ink mb-4">
              How we protect your data
            </h2>
            <p className="text-lg text-muted max-w-2xl leading-relaxed">
              Six layers of privacy, from storage to sync.
            </p>
          </motion.div>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
            className="grid md:grid-cols-2 gap-6"
          >
            {SECURITY_SECTIONS.map((section) => (
              <SecurityCard key={section.title} section={section} />
            ))}
          </motion.div>
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
            <div className="w-16 h-16 rounded-2xl bg-terracotta/10 flex items-center justify-center mx-auto mb-6">
              <Mail className="w-8 h-8 text-terracotta" strokeWidth={1.5} />
            </div>
            <h2 className="font-serif text-3xl text-ink mb-4">Found a vulnerability?</h2>
            <p className="text-lg text-muted mb-8 max-w-lg mx-auto leading-relaxed">
              We take security reports seriously. Reach out and we will respond within 24 hours.
            </p>
            <a
              href="mailto:security@memrynote.com"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-ink text-paper font-medium text-sm hover:bg-ink/90 transition-colors"
            >
              <Mail className="w-4 h-4" />
              security@memrynote.com
            </a>
          </motion.div>
        </Container>
      </section>
    </main>
  )
}
