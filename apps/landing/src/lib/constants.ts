import {
  Inbox,
  BookOpen,
  FileText,
  CheckSquare,
  Calendar,
  FolderOpen,
  Lock,
  Zap,
  Briefcase,
  GraduationCap,
  Laptop,
  Sparkles,
  Brain,
  PenLine,
  Rocket
} from 'lucide-react'

export const GITHUB_URL = 'https://github.com/memrynote/memry'
export const REDDIT_URL = 'https://www.reddit.com/r/MemryNote/'
export const DOCS_URL = 'https://docs.memrynote.com'
export const TWITTER_DEV_URL = 'https://x.com/h4yfans'

export const NAV_LINKS = [
  { label: 'Use Cases', href: '/use-cases' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Security', href: '/security' },
  { label: 'Docs', href: DOCS_URL }
] as const

export const FOOTER_LINKS = {
  product: [
    { label: 'Features', href: '#features' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Security', href: '/security' }
  ],
  social: [
    { label: 'Reddit', href: 'https://www.reddit.com/r/MemryNote/' },
    { label: 'Twitter', href: 'https://x.com/h4yfans' },
    { label: 'GitHub', href: 'https://github.com/memrynote/memry' }
  ]
} as const

export const VALUE_PROPS = [
  {
    icon: FolderOpen,
    title: 'Your Data',
    description: 'Plain Markdown files in a folder you choose. Portable, readable, yours forever.'
  },
  {
    icon: Lock,
    title: 'Private & Secure',
    description: "Your data stays on your device, encrypted end-to-end. Even we can't read it."
  },
  {
    icon: Zap,
    title: 'Instant Search',
    description:
      'Find anything across all your notes in milliseconds. No loading spinners, no cloud lag.'
  }
] as const

export const FEATURES = [
  {
    id: 'inbox',
    icon: Inbox,
    title: 'Inbox',
    tagline: 'Capture first, organize later.',
    description:
      'A space for processing incoming information. Local AI clustering detects related items and suggests bulk actions — nothing leaves your device.',
    highlights: ['AI-powered clustering', 'Quick capture', 'Snooze & file', 'Bulk actions'],
    screenshot: '/placeholders/feature-inbox.png'
  },
  {
    id: 'journal',
    icon: BookOpen,
    title: 'Journal',
    tagline: 'Reflect. Daily.',
    description:
      'A premium, reflective daily writing experience. Large writing area with dramatic date displays, time-based greetings, and day context showing your schedule and tasks.',
    highlights: ['Day context sidebar', 'Time-based greetings', 'Templates', 'Beautiful writing'],
    screenshot: '/placeholders/feature-journal.png'
  },
  {
    id: 'notes',
    icon: FileText,
    title: 'Notes',
    tagline: 'Your second brain, in Markdown.',
    description:
      'A file-first, markdown-based knowledge base with rich-text capabilities. Wiki-links connect your thoughts, and backlinks show you where ideas are referenced.',
    highlights: ['[[Wiki links]]', 'Backlinks', '8 property types', 'Version history'],
    screenshot: '/placeholders/feature-notes.png'
  },
  {
    id: 'tasks',
    icon: CheckSquare,
    title: 'Tasks',
    tagline: 'From thought to done.',
    description:
      'A multi-dimensional task management system. Toggle between List, Kanban, and Calendar views. Organize tasks into projects with custom statuses and recurring schedules.',
    highlights: ['Kanban/Calendar/List', 'Subtasks', 'Recurring tasks', 'Smart filters'],
    screenshot: '/placeholders/feature-tasks.png'
  }
] as const

export const COMPARISON_DATA = {
  headers: ['', 'Memry', 'Notion', 'Obsidian', 'Logseq'],
  rows: [
    { feature: 'Local-first', memry: true, notion: false, obsidian: true, logseq: true },
    {
      feature: 'Full task system',
      memry: true,
      notion: true,
      obsidian: 'partial' as const,
      logseq: 'partial' as const
    },
    {
      feature: 'Daily journal',
      memry: true,
      notion: 'partial' as const,
      obsidian: 'partial' as const,
      logseq: true
    },
    {
      feature: 'Inbox / quick capture',
      memry: true,
      notion: false,
      obsidian: 'partial' as const,
      logseq: 'partial' as const
    },
    { feature: 'Markdown files', memry: true, notion: false, obsidian: true, logseq: true },
    { feature: 'Free tier', memry: true, notion: 'partial' as const, obsidian: true, logseq: true },
    {
      feature: 'End-to-end encryption',
      memry: true,
      notion: false,
      obsidian: true,
      logseq: false
    },
    {
      feature: 'Calendar sync',
      memry: true,
      notion: 'partial' as const,
      obsidian: false,
      logseq: false
    },
    {
      feature: 'All-in-one (no plugins needed)',
      memry: true,
      notion: true,
      obsidian: false,
      logseq: 'partial' as const
    }
  ],
  footnote: ''
} as const

export const PRICING_TIERS = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    description: 'Perfect for personal use on a single device.',
    features: [
      'Unlimited notes & tasks',
      'Journal & Inbox',
      'Full-text search',
      'Local storage',
      'Markdown export'
    ],
    cta: 'Get Started',
    highlighted: false
  },
  {
    name: 'Pro',
    price: '$5',
    period: '/month',
    yearlyPrice: '$4/month billed yearly',
    description: 'For power users who need sync and collaboration.',
    features: [
      'Everything in Free',
      'Publish notes to web',
      'Real-time collaboration',
      'E2EE mobile sync',
      'Priority support'
    ],
    cta: 'Join Waitlist',
    highlighted: true
  }
] as const

export const FAQ_ITEMS = [
  {
    question: 'Is Memry free?',
    answer:
      'Memry offers a generous free tier for personal use on desktop. Core features like notes, tasks, journal, and inbox are completely free with no limits. Pro features like publishing to web, real-time collaboration, and mobile sync require a subscription.'
  },
  {
    question: 'Where is my data stored?',
    answer:
      'Your data lives in a "vault" folder on your computer that you choose. Notes are stored as plain Markdown files with YAML frontmatter for metadata. You can open them in any text editor.'
  },
  {
    question: 'Is my data secure?',
    answer:
      'Yes. Your data lives on your device — not our servers. When you use Pro features like sync, everything is encrypted end-to-end. Only you (and people you explicitly share with) can read your content. We literally cannot access it.'
  },
  {
    question: 'Can I sync between devices?',
    answer:
      "Absolutely! Since your vault is just a folder, you can use any sync service you prefer — Memry Sync, iCloud, Dropbox, Google Drive, Syncthing, or even Git. We don't lock you into our own sync solution."
  },
  {
    question: 'Is there a mobile app?',
    answer:
      'Desktop first (macOS, Windows, Linux) to nail the experience. Mobile apps for iOS and Android are targeting late 2026. In the meantime, your vault folder syncs with any cloud service you already use.'
  },
  {
    question: 'What file format does Memry use?',
    answer:
      'Standard Markdown with YAML frontmatter for properties. Your notes are 100% portable and can be read by any Markdown-compatible app like Obsidian, iA Writer, or even VS Code.'
  },
  {
    question: 'Can I import from other apps?',
    answer:
      'Yes! We will support importing from Obsidian (direct vault), Notion (export), Roam Research, and plain Markdown folders. Your existing knowledge base can move with you.'
  },
  {
    question: 'When will Memry launch?',
    answer:
      'Early access opens late Q3 2026, with a full public release targeting late 2026. Waitlist members get first access and can help shape the product before launch.'
  }
] as const

export const ROADMAP_DATA = {
  releaseDate: 'Late 2026',
  earlyAccess: 'Early access opens late Q3 2026',
  phases: [
    {
      status: 'done' as const,
      title: 'Core Foundation',
      items: [
        'Notes with Markdown & wiki-links',
        'Backlinks & bidirectional linking',
        'Full-text search',
        'Tasks with projects & custom statuses',
        'Kanban & Calendar views',
        'Subtasks & recurring tasks',
        'Daily journal with templates',
        'Quick capture inbox',
        'File attachments & version history',
        '8 property types for metadata',
        'Database view'
      ]
    },
    {
      status: 'in-progress' as const,
      title: 'Polish & AI',
      items: [
        'Canvas graph',
        'AI-powered inbox clustering (local model)',
        'Smart task suggestions',
        'Performance optimization',
        'Keyboard shortcuts refinement',
        'Accessibility improvements'
      ]
    },
    {
      status: 'planned' as const,
      title: 'Expansion',
      items: [
        'Mobile app — iOS & Android (targeting late 2026)',
        'Graph view for note connections',
        'CLI, MCP & API',
        'Google & Apple Calendar integration',
        'Multi-vault support',
        'Notion, Todoist & Readwise integration',
        'Templates marketplace'
      ]
    }
  ]
} as const

export const USE_CASES = [
  {
    id: 'knowledge-workers',
    icon: Laptop,
    title: 'Knowledge Workers',
    painQuote: 'My notes are in one app, tasks in another, and nothing connects.',
    description:
      'Stop context-switching between Notion, Todoist, and a journal app. Memry connects your research, tasks, and daily reflections in one local-first workspace — with wiki-links that actually build a knowledge graph.',
    features: [
      'AI-powered inbox clustering',
      '[[Wiki links]] & backlinks',
      'Full-text search in ms',
      'Markdown-native'
    ],
    workflow: [
      'Capture ideas in Inbox',
      'Process into linked Notes',
      'Track action items as Tasks',
      'Reflect in daily Journal'
    ]
  },
  {
    id: 'students',
    icon: GraduationCap,
    title: 'Students',
    painQuote: 'Lecture notes everywhere, deadlines slipping through the cracks.',
    description:
      'One workspace for lecture notes, assignments, and study schedules. Link concepts across courses, track deadlines in Calendar view, and build a personal knowledge base that grows with you.',
    features: [
      'Daily journal for study logs',
      'Notes organized by course',
      'Recurring task deadlines',
      'Calendar & Kanban views'
    ],
    workflow: [
      'Journal daily study sessions',
      'Link notes across courses',
      'Track assignments in Kanban',
      'Review with full-text search'
    ]
  },
  {
    id: 'freelancers',
    icon: Briefcase,
    title: 'Freelancers',
    painQuote: 'Client context is spread across five different apps.',
    description:
      'Manage every client in one vault — meeting notes, deliverables, invoices, and project timelines. Switch between Kanban for active work and Calendar for deadlines without ever leaving your workspace.',
    features: [
      'Project-based task views',
      'Kanban for deliverables',
      'Daily planning in Journal',
      '8 property types for metadata'
    ],
    workflow: [
      'Capture client requests in Inbox',
      'Plan deliverables in Kanban',
      'Track time in Journal',
      'Organize with metadata properties'
    ]
  },
  {
    id: 'adhd',
    icon: Brain,
    title: 'ADHD Brains',
    painQuote: 'Thoughts vanish before I can organize them.',
    description:
      "Capture first, organize later. The Inbox holds your thoughts so your brain doesn't have to. Zero-friction quick capture means nothing slips through — and AI clustering helps you make sense of the chaos when you're ready.",
    features: [
      'Zero-friction Inbox capture',
      'AI clustering for brain dumps',
      'Gentle daily Journal ritual',
      'No forced organization'
    ],
    workflow: [
      'Brain-dump into Inbox',
      'AI groups related thoughts',
      "Process when you're ready",
      'Build structure gradually'
    ]
  },
  {
    id: 'writers',
    icon: PenLine,
    title: 'Writers',
    painQuote: 'Ideas scatter across drafts and sticky notes.',
    description:
      'A distraction-free Markdown editor that connects your ideas. Wiki-links weave a web of research, characters, and plot threads. Backlinks reveal unexpected connections between drafts.',
    features: [
      'Distraction-free Markdown editor',
      '[[Wiki links]] between drafts',
      'Backlinks for research threads',
      'Version history for every note'
    ],
    workflow: [
      'Capture sparks in Inbox',
      'Draft in focused editor',
      'Link research with wiki-links',
      'Track revisions over time'
    ]
  },
  {
    id: 'founders',
    icon: Rocket,
    title: 'Founders',
    painQuote: 'Strategy docs, tasks, and reflections live in 10 different tabs.',
    description:
      'Run your company from one encrypted workspace. Strategy docs link to action items, OKRs live next to daily standups, and everything stays private — even from us.',
    features: [
      'All-in-one workspace',
      'End-to-end encryption',
      'Kanban for sprint planning',
      'Journal for founder reflections'
    ],
    workflow: [
      'Plan strategy in Notes',
      'Break into Tasks with Kanban',
      'Journal daily reflections',
      'Review progress in Calendar'
    ]
  },
  {
    id: 'personal',
    icon: Sparkles,
    title: 'Personal Productivity',
    painQuote: 'Life admin is overwhelming and nothing has a home.',
    description:
      'Give every thought, task, and plan a home. From grocery lists to long-term goals, from morning pages to habit tracking — all private, all yours, all in one place.',
    features: [
      'Quick capture Inbox',
      'Reflective daily Journal',
      'Subtasks & recurring habits',
      'Private & encrypted'
    ],
    workflow: [
      'Quick-capture throughout the day',
      'Process in evening review',
      'Track habits with recurring tasks',
      'Reflect in morning Journal'
    ]
  }
] as const

export type SyncPlanId = 'standard' | 'plus' | 'believer'

export type SyncPlanEmphasis = 'standard' | 'recommended' | 'founding'

export type SyncPlanTier = {
  id: SyncPlanId
  name: string
  tagline: string
  monthlyPrice: number | null
  annualPrice: number | null
  annualMonthlyEquivalent: number | null
  lifetimePrice: number | null
  limits: {
    vaults: string
    storage: string
    fileSize: string
    history: string
  }
  features: readonly string[]
  cta: string
  emphasis: SyncPlanEmphasis
  ribbon?: string
}

export const SYNC_PLAN_TIERS: readonly SyncPlanTier[] = [
  {
    id: 'standard',
    name: 'Sync Standard',
    tagline: 'One vault, encrypted, everywhere.',
    monthlyPrice: 5,
    annualPrice: 48,
    annualMonthlyEquivalent: 4,
    lifetimePrice: null,
    limits: {
      vaults: '1',
      storage: '1 GiB',
      fileSize: '5 MiB',
      history: '30 d'
    },
    features: [
      'End-to-end encrypted sync',
      'Unlimited devices on one account',
      'Server never sees plaintext',
      '30 days of version history',
      '7-day money-back guarantee'
    ],
    cta: 'Get Sync Standard',
    emphasis: 'standard'
  },
  {
    id: 'plus',
    name: 'Sync Plus',
    tagline: 'Multiple vaults. Big files. Deep history.',
    monthlyPrice: 10,
    annualPrice: 96,
    annualMonthlyEquivalent: 8,
    lifetimePrice: null,
    limits: {
      vaults: '10',
      storage: '10 GiB',
      fileSize: '200 MiB',
      history: '365 d'
    },
    features: [
      'Everything in Sync Standard',
      'Up to 10 separate vaults',
      'Large attachments and PDFs',
      'A full year of version history',
      'Priority support — straight from the founder'
    ],
    cta: 'Get Sync Plus',
    emphasis: 'recommended',
    ribbon: 'Most popular'
  },
  {
    id: 'believer',
    name: 'Believer',
    tagline: 'Pay once. Sync forever. Every future paid feature included.',
    monthlyPrice: null,
    annualPrice: null,
    annualMonthlyEquivalent: null,
    lifetimePrice: 500,
    limits: {
      vaults: '10',
      storage: '10 GiB',
      fileSize: '200 MiB',
      history: '365 d'
    },
    features: [
      'Lifetime Sync Plus — never billed again',
      'Every future paid feature, included forever',
      'Recognized as a founding supporter',
      'Direct line to the founder',
      'Limited slots'
    ],
    cta: 'Become a Believer',
    emphasis: 'founding',
    ribbon: 'Founding supporter'
  }
] as const

export const PLAN_LIMIT_MATRIX = {
  headers: ['', 'Sync Standard', 'Sync Plus', 'Believer'] as const,
  rows: [
    { feature: 'Synced vaults', standard: '1', plus: '10', believer: '10' },
    { feature: 'Total storage', standard: '1 GiB', plus: '10 GiB', believer: '10 GiB' },
    { feature: 'Max file size', standard: '5 MiB', plus: '200 MiB', believer: '200 MiB' },
    { feature: 'Version history', standard: '30 days', plus: '365 days', believer: '365 days' },
    {
      feature: 'Devices per account',
      standard: 'Unlimited',
      plus: 'Unlimited',
      believer: 'Unlimited'
    },
    { feature: 'Monthly billing', standard: '$5', plus: '$10', believer: '—' },
    { feature: 'Annual billing', standard: '$48 ($4/mo)', plus: '$96 ($8/mo)', believer: '—' },
    { feature: 'Lifetime', standard: '—', plus: '—', believer: '$500 once' },
    {
      feature: 'Future paid features',
      standard: 'In tier',
      plus: 'In tier',
      believer: 'Included forever'
    }
  ] as const
} as const

export type LifecycleTone = 'sage' | 'amber' | 'terracotta' | 'terracotta-dim' | 'ink'

export const LIFECYCLE_STAGES: readonly {
  id: string
  label: string
  days: string
  description: string
  tone: LifecycleTone
}[] = [
  {
    id: 'active',
    label: 'Active',
    days: 'Day 0',
    description: 'Sync runs everywhere. All limits apply per tier.',
    tone: 'sage'
  },
  {
    id: 'grace',
    label: 'Grace',
    days: '+ 14 days',
    description: 'Sync keeps working. Time to fix the card or change your mind.',
    tone: 'amber'
  },
  {
    id: 'read-only',
    label: 'Read-only',
    days: '+ 30 days',
    description: 'Pulls succeed, pushes blocked. Pull everything to local at your pace.',
    tone: 'terracotta'
  },
  {
    id: 'purged',
    label: 'Purged status',
    days: 'Day 44',
    description: 'Server returns 402 on every request. Encrypted blobs untouched.',
    tone: 'terracotta-dim'
  },
  {
    id: 'deleted',
    label: 'Blobs deleted',
    days: 'Day 90',
    description: 'Encrypted blobs physically removed from R2. Recovery ends.',
    tone: 'ink'
  }
] as const

export const PRICING_FAQ_ITEMS = [
  {
    question: 'Is the local app still free?',
    answer:
      'Yes. Notes, tasks, journal, and inbox stay free, forever, no account required. Sync between devices is the paid layer — and only the paid layer.'
  },
  {
    question: 'What happens if my card fails or I cancel?',
    answer:
      'You get 14 days of grace where sync keeps working, then 30 days of read-only mode where pulls still succeed. After day 44 your account is marked purged but encrypted blobs sit untouched on our servers until day 90 — re-subscribe before then and everything restores intact.'
  },
  {
    question: 'You store my data, but you cannot read it. What does that actually mean?',
    answer:
      'Every byte is encrypted on your device with XChaCha20-Poly1305 before it leaves. The keys live in your password manager and never touch our servers. We hold ciphertext, count bytes for billing, and that is the limit of what we see.'
  },
  {
    question: 'How does the refund policy work?',
    answer:
      '7-day money-back guarantee on every plan, including Believer. Request it inside the app — Paddle processes the refund back to your original payment method, no questions asked.'
  },
  {
    question: 'What is the Believer tier really?',
    answer:
      'A bet on us. You pay once, get lifetime Sync Plus, and inherit every paid feature we ship from now until forever. Roughly five years of annual Plus, with no expiry. Slots may be limited later.'
  },
  {
    question: 'Can I upgrade or downgrade later?',
    answer:
      'Yes. Upgrades pro-rate immediately. Downgrades take effect at the end of your billing period — if you have more vaults than the new tier allows, existing data stays readable while you archive what you no longer need.'
  },
  {
    question: 'Do you handle VAT and sales tax?',
    answer:
      'Yes. Paddle is the merchant of record and handles VAT, GST, and US sales tax across 60+ countries. The price you see at checkout is the price you pay.'
  },
  {
    question: 'Which payment methods are accepted?',
    answer:
      'Cards, Apple Pay, Google Pay, PayPal, and several regional methods depending on your country — all processed through Paddle.'
  }
] as const

export const FLOW_STEPS = [
  {
    id: 'inbox',
    icon: Inbox,
    title: 'Inbox',
    tagline: 'Capture first, organize later.',
    competitorLabel: 'Only in',
    competitors: [{ name: 'MemryNote', logo: '/competitors/memry.png' }]
  },
  {
    id: 'journal',
    icon: BookOpen,
    title: 'Journal',
    tagline: 'Reflect. Daily.',
    competitors: [
      { name: 'Google Keep', logo: '/competitors/google-keep.png' },
      { name: 'Apple Notes', logo: '/competitors/apple-notes.png' },
      { name: 'OneNote', logo: '/competitors/onenote-clipper.png' },
      { name: 'Evernote Clipper', logo: '/competitors/evernote-clipper.png' }
    ]
  },
  {
    id: 'notes',
    icon: FileText,
    title: 'Notes',
    tagline: 'Your second brain, in Markdown.',
    competitors: [
      { name: 'Notion', logo: '/competitors/notion.png' },
      { name: 'Bear', logo: '/competitors/bear.png' },
      { name: 'Roam', logo: '/competitors/roam.png' },
      { name: 'Evernote', logo: '/competitors/evernote.png' }
    ]
  },
  {
    id: 'tasks',
    icon: CheckSquare,
    title: 'Tasks',
    tagline: 'From thought to done.',
    competitors: [
      { name: 'Todoist', logo: '/competitors/todoist.png' },
      { name: 'Things', logo: '/competitors/things.png' },
      { name: 'Google Tasks', logo: '/competitors/google-tasks.png' }
    ]
  },
  {
    id: 'calendar',
    icon: Calendar,
    title: 'Calendar',
    tagline: 'Schedule it all.',
    competitors: [
      { name: 'Google Cal', logo: '/competitors/google-cal.png' },
      { name: 'Outlook', logo: '/competitors/outlook.png' },
      { name: 'Apple Cal', logo: '/competitors/apple-cal.png' }
    ]
  }
] as const
