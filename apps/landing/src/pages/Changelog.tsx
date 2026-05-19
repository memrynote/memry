import rawChangelog from '../../../../CHANGELOG.md?raw'
import { ArrowRight, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { GITHUB_URL } from '@/lib/constants'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

interface ChangelogSection {
  label: string
  items: string[]
}

interface ChangelogEntry {
  date: string
  title: string
  sections: ChangelogSection[]
}

const ENTRY_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/
const SECTION_HEADING = /^###\s+(.+)$/
const MAX_ENTRIES = 12

function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let currentEntry: ChangelogEntry | null = null
  let currentSection: ChangelogSection | null = null

  for (const line of markdown.split('\n')) {
    const entryMatch = line.match(ENTRY_HEADING)

    if (entryMatch) {
      currentEntry = {
        date: entryMatch[1],
        title: entryMatch[2],
        sections: []
      }
      entries.push(currentEntry)
      currentSection = null
      continue
    }

    if (!currentEntry) continue

    const sectionMatch = line.match(SECTION_HEADING)

    if (sectionMatch) {
      currentSection = {
        label: sectionMatch[1],
        items: []
      }
      currentEntry.sections.push(currentSection)
      continue
    }

    if (currentSection && line.startsWith('- ')) {
      currentSection.items.push(cleanChangelogText(line.slice(2)))
    }
  }

  return entries
    .map((entry) => ({
      ...entry,
      sections: entry.sections.filter((section) => section.items.length > 0)
    }))
    .filter((entry) => entry.sections.length > 0)
}

function cleanChangelogText(text: string) {
  return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
}

const CHANGELOG_ENTRIES = parseChangelog(rawChangelog).slice(0, MAX_ENTRIES)

export function ChangelogPage() {
  return (
    <>
      <PageHead page="changelog" />
      <main className="pt-32 pb-24 md:pt-40">
        <Container size="md">
          <motion.section
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
            className="border-b border-border pb-12"
          >
            <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
              Release notes
            </p>
            <h1 className="mt-4 font-serif text-5xl leading-[1.05] text-ink md:text-6xl">
              Changelog
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">
              Recent product updates, fixes, and shipped Memry work. For every tagged desktop
              release, use GitHub releases.
            </p>
            <div className="mt-8 flex flex-wrap gap-3 text-sm">
              <a
                href={`${GITHUB_URL}/releases`}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-medium text-ink transition-colors hover:border-terracotta/30 hover:text-terracotta"
              >
                GitHub releases
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <Link
                to="/roadmap"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-medium text-ink transition-colors hover:border-terracotta/30 hover:text-terracotta"
              >
                Roadmap
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </motion.section>

          <section className="divide-y divide-border">
            {CHANGELOG_ENTRIES.map((entry) => (
              <article key={`${entry.date}-${entry.title}`} className="py-10">
                <div className="grid gap-5 md:grid-cols-[150px_1fr] md:gap-10">
                  <div>
                    <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted">
                      {entry.date}
                    </p>
                  </div>
                  <div>
                    <h2 className="font-serif text-2xl leading-tight text-ink md:text-3xl">
                      {entry.title}
                    </h2>
                    <div className="mt-6 grid gap-6">
                      {entry.sections.map((section) => (
                        <section key={`${entry.date}-${section.label}`}>
                          <h3 className="inline-flex items-center gap-2 font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
                            <FileText className="h-3.5 w-3.5" aria-hidden />
                            {section.label}
                          </h3>
                          <ul className="mt-3 grid gap-3 text-base leading-relaxed text-muted">
                            {section.items.map((item) => (
                              <li key={item} className="flex gap-3">
                                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta/70" />
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </section>
        </Container>
      </main>
    </>
  )
}
