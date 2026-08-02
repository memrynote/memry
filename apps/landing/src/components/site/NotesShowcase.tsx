import { Link } from 'react-router'
import { ArrowRight, FolderOpen, Link2, Mic, Scissors } from 'lucide-react'
import { FeatureChip, HomeSection, MegaCard, SectionTitle } from '@/components/site/primitives'
import { NoteEditorWidget } from '@/components/site/widgets/NoteEditorWidget'

const CHIP_ICON_CLASS = 'h-4 w-4 text-terracotta'

const NOTE_CHIPS = [
  { label: 'Markdown & backlinks', icon: <Link2 className={CHIP_ICON_CLASS} /> },
  { label: 'Obsidian-compatible vault', icon: <FolderOpen className={CHIP_ICON_CLASS} /> },
  {
    label: 'Web clipper',
    icon: <Scissors className={CHIP_ICON_CLASS} />,
    href: '/features/web-clipper'
  },
  { label: 'Voice capture', icon: <Mic className={CHIP_ICON_CLASS} /> }
] as const

/**
 * "WRITE" mega-card — soft sky tint, live note-editor widget on the start
 * side, a quiet rail of feature chips on the end side.
 */
export function NotesShowcase() {
  return (
    <HomeSection id="write">
      <MegaCard tint="sky" eyebrow="WRITE">
        <SectionTitle
          title="From first thought to final form"
          sub={
            <>
              Markdown notes, backlinks, an editor that stays out of the way — and every note is a
              plain{' '}
              <code className="rounded bg-ink/5 px-1 py-0.5 font-mono text-[0.85em]">.md</code> file
              in an Obsidian-compatible vault.
            </>
          }
        />

        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-12">
          <div>
            <div className="relative">
              <div
                aria-hidden
                className="absolute inset-0 -rotate-2 translate-y-3 rounded-2xl border border-ink/5 bg-card/60"
              />
              <NoteEditorWidget className="relative" />
            </div>
            <p className="mt-6 text-xs text-muted">Live demo — try it</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {NOTE_CHIPS.map((chip) => (
              <FeatureChip
                key={chip.label}
                icon={chip.icon}
                label={chip.label}
                href={'href' in chip ? chip.href : undefined}
                className="w-full"
              />
            ))}

            <Link
              to="/features/notes"
              className="group mt-2 inline-flex items-center gap-1.5 justify-self-start text-sm font-medium text-terracotta transition-colors hover:text-terracotta/80"
            >
              Learn more about notes
              <ArrowRight
                aria-hidden
                className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5"
              />
            </Link>
          </div>
        </div>
      </MegaCard>
    </HomeSection>
  )
}
