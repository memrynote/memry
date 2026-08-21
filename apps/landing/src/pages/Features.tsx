import {
  type LucideIcon,
  Inbox,
  BookOpen,
  FileText,
  CheckSquare,
  Search,
  Shield,
  Layout,
  Sparkles,
  Link2,
  Bell,
  Bookmark,
  FileCode,
  FolderOpen,
  Globe,
  Mic,
  Image,
  FileVideo,
  Scissors,
  MessageSquare,
  Calendar,
  Columns3,
  List,
  Filter,
  RotateCcw,
  GitBranch,
  Clock,
  Hash,
  Palette,
  Type,
  ToggleLeft,
  Star,
  ListOrdered,
  ArrowUpDown,
  StickyNote,
  Layers,
  PenTool,
  Table,
  Code,
  Quote,
  ListChecks,
  Zap,
  Brain,
  HardDrive,
  ChevronRight,
  PanelLeft
} from 'lucide-react'
import { motion } from 'motion/react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { FinalCta } from '@/components/site/FinalCta'
import { PageHero } from '@/components/site/PageHero'
import { FeatureChip, SectionTitle } from '@/components/site/primitives'

interface FeatureItem {
  icon: LucideIcon
  title: string
  description: string
}

interface PillarSection {
  id: string
  icon: LucideIcon
  title: string
  tagline: string
  description: string
  features: FeatureItem[]
}

const PILLARS: PillarSection[] = [
  {
    id: 'inbox',
    icon: Inbox,
    title: 'Inbox',
    tagline: 'Capture first, organize later.',
    description:
      'A contemplative space for processing incoming information. Grab anything from anywhere — optional AI helps when you want it.',
    features: [
      {
        icon: Zap,
        title: 'Quick Capture',
        description: 'Grab links, images, voice memos, PDFs, and web clips instantly.'
      },
      {
        icon: Mic,
        title: 'Voice Memos',
        description: 'Record and transcribe voice notes with automatic speech-to-text.'
      },
      {
        icon: Scissors,
        title: 'Web Clips',
        description: 'Clip quoted text with full source context from any webpage.'
      },
      {
        icon: FileCode,
        title: 'PDF Extraction',
        description: 'Import PDFs with automatic text extraction and OCR.'
      },
      {
        icon: Globe,
        title: 'Social Posts',
        description: 'Save posts from Twitter, LinkedIn, Mastodon, Bluesky, and Threads.'
      },
      {
        icon: Image,
        title: 'Image Capture',
        description: 'Save images with EXIF metadata, dimensions, and captions.'
      },
      {
        icon: FileVideo,
        title: 'Video & Audio',
        description: 'Attach video and audio files with metadata tracking.'
      },
      {
        icon: Link2,
        title: 'Link Metadata',
        description: 'Auto-extract title, description, hero image, favicon, and author.'
      },
      {
        icon: Brain,
        title: 'Optional AI Filing',
        description: 'Turn on smart suggestions when you want help filing things over time.'
      },
      {
        icon: Clock,
        title: 'Snooze',
        description: 'Not ready? Snooze items with custom timing and reason.'
      },
      {
        icon: FolderOpen,
        title: 'File & Archive',
        description: 'File items to notes, folders, or tasks. Archive when done.'
      },
      {
        icon: Hash,
        title: 'Tag Suggestions',
        description: 'Get tag recommendations before filing based on content.'
      },
      {
        icon: Layers,
        title: 'Inbox Insights',
        description: 'Capture heatmap, type distribution, and filing analytics.'
      }
    ]
  },
  {
    id: 'journal',
    icon: BookOpen,
    title: 'Journal',
    tagline: 'Reflect. Daily.',
    description:
      'A premium, reflective daily writing experience with rich context and statistics to build your writing habit.',
    features: [
      {
        icon: PenTool,
        title: 'Daily Entries',
        description: 'Date-stamped markdown entries with a beautiful writing area.'
      },
      {
        icon: Calendar,
        title: 'Date Navigation',
        description: 'Navigate by calendar, month view, or year overview.'
      },
      {
        icon: Palette,
        title: 'Activity Heatmap',
        description: 'Visualize your writing habit with a GitHub-style contribution graph.'
      },
      {
        icon: Layers,
        title: 'Monthly & Yearly Stats',
        description: 'Entry count, word count, and average activity over time.'
      },
      {
        icon: PanelLeft,
        title: 'Day Context Sidebar',
        description: 'See your schedule, tasks, and related notes alongside your entry.'
      },
      {
        icon: Clock,
        title: 'Time-Based Greetings',
        description: 'Dynamic greeting that changes based on time of day.'
      },
      {
        icon: FileCode,
        title: 'Templates',
        description: 'Start each day from a template with pre-filled structure.'
      },
      {
        icon: Bell,
        title: 'Journal Reminders',
        description: 'Set reminders to revisit specific journal entries.'
      },
      {
        icon: MessageSquare,
        title: 'Highlight Reminders',
        description: 'Remind yourself about specific highlighted text passages.'
      },
      {
        icon: ChevronRight,
        title: 'Floating Day Context',
        description: 'Quick peek at adjacent days without leaving your entry.'
      }
    ]
  },
  {
    id: 'notes',
    icon: FileText,
    title: 'Notes',
    tagline: 'Your second brain, in Markdown.',
    description:
      'A file-first, markdown-based knowledge base with rich-text editing, wiki-links, and powerful properties.',
    features: [
      {
        icon: Type,
        title: 'Rich Markdown Editor',
        description: 'Bold, italic, headings, lists, tables, code blocks, and blockquotes.'
      },
      {
        icon: Link2,
        title: 'Wiki-Links',
        description: '[[Note Title]] syntax with autocomplete to connect your thoughts.'
      },
      {
        icon: GitBranch,
        title: 'Backlinks',
        description: 'See every note that references the current one, with context.'
      },
      {
        icon: Hash,
        title: 'Tags',
        description: '#tag syntax with color coding, autocomplete, and tag definitions.'
      },
      {
        icon: ListOrdered,
        title: '8 Property Types',
        description: 'Text, number, checkbox, date, URL, rating, select, multiselect.'
      },
      {
        icon: RotateCcw,
        title: 'Version History',
        description: 'Auto and manual snapshots with side-by-side content diff view.'
      },
      {
        icon: StickyNote,
        title: 'Aliases',
        description: 'Alternative names for notes — find them however you remember them.'
      },
      { icon: FileCode, title: 'Export', description: 'Export any note to PDF or Markdown.' },
      {
        icon: Image,
        title: 'File Attachments',
        description: 'Embed images, PDFs, audio, and video directly in your notes.'
      },
      {
        icon: Table,
        title: 'Tables',
        description: 'Full table support with headers and cell editing.'
      },
      {
        icon: Code,
        title: 'Code Blocks',
        description: 'Syntax-highlighted code blocks for developers.'
      },
      {
        icon: Quote,
        title: 'Blockquotes',
        description: 'Quote formatting for citations and callouts.'
      },
      {
        icon: ListChecks,
        title: 'Task Lists',
        description: 'Inline checkbox lists to track to-dos within notes.'
      },
      {
        icon: Sparkles,
        title: 'Slash Commands',
        description: 'Type / to insert blocks, links, and more.'
      },
      {
        icon: PenTool,
        title: 'Bubble Menu',
        description: 'Select text to get a context-aware formatting toolbar.'
      },
      {
        icon: Layers,
        title: 'Folder Views',
        description: 'Database-like table views with sortable, filterable columns.'
      },
      {
        icon: ArrowUpDown,
        title: 'Formula Columns',
        description: 'Computed columns with formula support in folder views.'
      },
      { icon: Star, title: 'Emoji Icons', description: 'Visual emoji identifiers for every note.' },
      {
        icon: HardDrive,
        title: 'Plain Markdown Files',
        description: 'Your notes are .md files in a folder you choose. Portable forever.'
      }
    ]
  },
  {
    id: 'tasks',
    icon: CheckSquare,
    title: 'Tasks',
    tagline: 'From thought to done.',
    description:
      'A multi-dimensional task management system with projects, views, recurrence, and deep integration with your notes.',
    features: [
      {
        icon: FolderOpen,
        title: 'Projects',
        description: 'Group tasks into projects with custom colors and icons.'
      },
      {
        icon: ToggleLeft,
        title: 'Custom Statuses',
        description: 'Define unique statuses per project for your workflow.'
      },
      {
        icon: GitBranch,
        title: 'Subtasks',
        description: 'Break tasks into subtasks with progress tracking.'
      },
      {
        icon: RotateCcw,
        title: 'Recurring Tasks',
        description: 'Daily, weekly, monthly, yearly — with flexible frequency control.'
      },
      {
        icon: ArrowUpDown,
        title: '5-Level Priority',
        description: 'None, low, medium, high, or urgent — sort and filter by priority.'
      },
      {
        icon: Calendar,
        title: 'Due & Start Dates',
        description: 'Set deadlines and start dates with time granularity.'
      },
      {
        icon: Columns3,
        title: 'Kanban View',
        description: 'Drag-and-drop columns organized by status.'
      },
      {
        icon: Calendar,
        title: 'Calendar View',
        description: 'Tasks plotted on a calendar with drag-drop rescheduling.'
      },
      {
        icon: List,
        title: 'List View',
        description: 'Traditional task list with grouping and sorting.'
      },
      {
        icon: Clock,
        title: 'Today & Upcoming',
        description: "See what's due now and what's coming next."
      },
      {
        icon: Filter,
        title: 'Smart Filters',
        description: 'Filter by priority, project, status, date, tags, and more.'
      },
      {
        icon: Bookmark,
        title: 'Saved Filter Presets',
        description: 'Save your favorite filter combinations for one-click access.'
      },
      {
        icon: Layers,
        title: 'Bulk Actions',
        description: 'Multi-select tasks for batch operations.'
      },
      {
        icon: Zap,
        title: 'Quick Add',
        description: 'Inline task creation with natural language date parsing.'
      },
      {
        icon: Link2,
        title: 'Task-Note Linking',
        description: 'Link tasks to notes for full context.'
      },
      { icon: Hash, title: 'Task Tags', description: 'Tag tasks for cross-project organization.' },
      {
        icon: Sparkles,
        title: 'Completion Celebration',
        description: 'Satisfying animation when you check things off.'
      },
      { icon: RotateCcw, title: 'Undo', description: 'Accidentally complete? Cmd+Z to undo.' },
      {
        icon: FolderOpen,
        title: 'Archive',
        description: 'Archive completed tasks to keep your lists clean.'
      }
    ]
  }
]

interface SupportCategory {
  icon: LucideIcon
  title: string
  features: string[]
}

const SUPPORTING: SupportCategory[] = [
  {
    icon: Search,
    title: 'Search & Discovery',
    features: [
      'Full-text search (SQLite FTS5)',
      'Command palette (Cmd+P)',
      'Search everywhere (Cmd+Shift+F)',
      'In-view search (Cmd+F)',
      'Type, tag & project filtering',
      'Date range filtering',
      'Relevance ranking',
      'Context snippets in results'
    ]
  },
  {
    icon: Shield,
    title: 'Sync & Security',
    features: [
      'End-to-end encryption (libsodium)',
      'Multi-device sync (CRDT)',
      'Offline-first architecture',
      'Device linking via QR code',
      'OS keychain credential storage',
      'Conflict-free merging (Yjs)',
      'Per-field vector clocks',
      'Incremental sync'
    ]
  },
  {
    icon: Layout,
    title: 'Workspace',
    features: [
      'Tabbed interface',
      'Pin & reorder tabs',
      'Split pane (vertical / horizontal)',
      'Drag tabs between panes',
      'Session persistence',
      'Reopen closed tabs',
      '30+ keyboard shortcuts',
      'Command palette'
    ]
  },
  {
    icon: Sparkles,
    title: 'AI Assistant',
    features: [
      'On/off from settings',
      'Global AI panel',
      'Chat & compose modes',
      'Attach notes as context',
      'Optional AI-powered suggestions',
      'Smart summarization',
      'Filing recommendations'
    ]
  }
]

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } }
}

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT_EXPO } }
}

function FeatureCard({ feature }: { feature: FeatureItem }) {
  const Icon = feature.icon
  return (
    <motion.div
      variants={fadeUp}
      className="group relative p-5 rounded-xl border border-border bg-card hover:shadow-card transition-shadow"
    >
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-terracotta/8 flex items-center justify-center">
          <Icon className="w-5 h-5 text-terracotta" strokeWidth={1.5} />
        </div>
        <div>
          <h4 className="font-serif text-lg text-ink mb-1">{feature.title}</h4>
          <p className="text-sm text-muted leading-relaxed">{feature.description}</p>
        </div>
      </div>
    </motion.div>
  )
}

function PillarBlock({ pillar, index }: { pillar: PillarSection; index: number }) {
  const Icon = pillar.icon
  const isAlt = index % 2 === 1

  return (
    <section id={pillar.id} className={isAlt ? 'py-20 bg-paper-alt' : 'py-20'}>
      <Container>
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
          className="mb-12"
        >
          <div className="flex items-center gap-4 mb-4">
            <div className="w-12 h-12 rounded-xl bg-terracotta/10 flex items-center justify-center">
              <Icon className="w-6 h-6 text-terracotta" strokeWidth={1.5} />
            </div>
            <div>
              <h2 className="font-serif text-3xl md:text-4xl text-ink">{pillar.title}</h2>
            </div>
          </div>
          <p className="text-xl text-terracotta font-serif italic mb-3">{pillar.tagline}</p>
          <p className="text-muted text-lg max-w-2xl leading-relaxed">{pillar.description}</p>
        </motion.div>

        <motion.div
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
        >
          {pillar.features.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

function SupportingBlock({ category }: { category: SupportCategory }) {
  const Icon = category.icon
  return (
    <motion.div variants={fadeUp} className="p-6 rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-lg bg-terracotta/8 flex items-center justify-center">
          <Icon className="w-5 h-5 text-terracotta" strokeWidth={1.5} />
        </div>
        <h3 className="font-serif text-xl text-ink">{category.title}</h3>
      </div>
      <ul className="space-y-2.5">
        {category.features.map((f) => (
          <li key={f} className="flex items-start gap-3 text-sm text-ink/80">
            <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-terracotta/50 flex-shrink-0" />
            {f}
          </li>
        ))}
      </ul>
    </motion.div>
  )
}

/** The four pillars as hero chips — each one an in-page anchor down to its block. */
function PillarChips() {
  return (
    <>
      {PILLARS.map((p) => {
        const Icon = p.icon

        return (
          <FeatureChip
            key={p.id}
            href={`#${p.id}`}
            label={p.title}
            icon={<Icon className="h-4 w-4" strokeWidth={1.5} />}
          />
        )
      })}
    </>
  )
}

export function FeaturesPage() {
  return (
    <>
      <PageHead page="features" />
      <PageHero
        title="All your features"
        sub="One app. Every tool you need. 115+ features across four integrated pillars — no plugins required."
        actions={<PillarChips />}
      />

      {PILLARS.map((pillar, i) => (
        <PillarBlock key={pillar.id} pillar={pillar} index={i} />
      ))}

      <section className="py-20">
        <Container>
          <SectionTitle
            title="Supporting features"
            sub="Search, sync, workspace, and optional AI — the infrastructure that ties everything together."
          />
          <motion.div
            className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5"
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
          >
            {SUPPORTING.map((cat) => (
              <SupportingBlock key={cat.title} category={cat} />
            ))}
          </motion.div>
        </Container>
      </section>

      <FinalCta
        title="Ready to get started?"
        sub="Free, local-first, and open source."
        location="features-final"
      />
    </>
  )
}
