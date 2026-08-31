import {
  Inbox,
  BookOpen,
  FileText,
  CheckSquare,
  Calendar,
  Briefcase,
  GraduationCap,
  Laptop,
  Sparkles,
  Brain,
  PenLine,
  Rocket,
  type LucideIcon
} from 'lucide-react'

export const GITHUB_URL = 'https://github.com/memrynote/memry'
export const REDDIT_URL = 'https://www.reddit.com/r/MemryNote/'
const DOCS_URL = 'https://docs.memrynote.com'
export const TWITTER_DEV_URL = 'https://x.com/h4yfans'
export const CHECKOUT_RELEASE_TIMING = 'Coming soon'

type LandingDropdownItemBase = {
  label: string
  description: string
  href: string
  disabled?: boolean
  // Status pill text. Defaults to "Soon" for disabled items; set explicitly for live-but-pending items.
  badge?: string
}

export type LandingDropdownItem =
  | (LandingDropdownItemBase & {
      icon: LucideIcon
      iconType?: undefined
    })
  | (LandingDropdownItemBase & {
      // Path to a hand-drawn mascot PNG under public/mascots
      icon: string
      iconType: 'image'
    })

export const FEATURE_NAV_ITEMS: readonly LandingDropdownItem[] = [
  {
    label: 'Inbox',
    description: 'Capture links, files, voice',
    href: '/features/inbox',
    icon: '/mascots/inbox.webp',
    iconType: 'image'
  },
  {
    label: 'Journal',
    description: 'Daily writing with context',
    href: '/features/journal',
    icon: '/mascots/journal.webp',
    iconType: 'image'
  },
  {
    label: 'Notes',
    description: 'Markdown, backlinks, properties',
    href: '/features/notes',
    icon: '/mascots/notes.webp',
    iconType: 'image'
  },
  {
    label: 'Tasks',
    description: 'Projects, kanban, recurring work',
    href: '/features/tasks',
    icon: '/mascots/tasks.webp',
    iconType: 'image'
  },
  {
    label: 'Calendar',
    description: 'Schedule, deadlines, day view',
    href: '/features/calendar',
    icon: '/mascots/calendar.webp',
    iconType: 'image'
  },
  {
    label: 'AI Agent',
    description: 'Optional. Turn AI on or off anytime.',
    href: '/features/ai-agent',
    icon: '/mascots/ai-agent.webp',
    iconType: 'image'
  }
] as const

export const DOWNLOAD_NAV_ITEMS: readonly LandingDropdownItem[] = [
  {
    label: 'Web Clipper',
    description: 'Clip and save any link',
    href: '/features/web-clipper',
    icon: '/mascots/web-clipper.webp',
    iconType: 'image'
  },
  {
    label: 'memrynote for Mobile',
    description: 'iOS and Android apps',
    href: '#',
    icon: '/mascots/mobile.webp',
    iconType: 'image',
    disabled: true
  },
  {
    label: 'memrynote for Desktop',
    description: 'macOS · Windows · Linux',
    href: '/download/desktop',
    icon: '/mascots/desktop.webp',
    iconType: 'image'
  },
  {
    label: 'memrynote CLI',
    description: 'Terminal workflows',
    href: '/cli',
    icon: '/mascots/cli.webp',
    iconType: 'image'
  }
] as const

export const DIRECT_NAV_LINKS = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'Roadmap', href: '/roadmap' }
] as const

export const FOOTER_LINKS = {
  product: [
    { label: 'Features', href: '/features' },
    { label: 'Download', href: '/download/desktop' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Changelog', href: '/changelog' },
    { label: 'Security', href: '/security' }
  ],
  // Footer shows only marquee competitors; the long tail lives on the /compare hub.
  compare: [
    { label: 'vs Obsidian', href: '/obsidian-alternative' },
    { label: 'vs Notion', href: '/notion-alternative' },
    { label: 'vs Evernote', href: '/evernote-alternative' },
    { label: 'vs Apple Notes', href: '/apple-notes-alternative' },
    { label: 'Compare all', href: '/compare' }
  ],
  resources: [
    { label: 'Blog', href: '/blog' },
    { label: 'Docs', href: DOCS_URL },
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Refund Policy', href: '/refund' }
  ],
  social: [
    { label: 'Reddit', href: 'https://www.reddit.com/r/MemryNote/' },
    { label: 'Twitter', href: 'https://x.com/h4yfans' },
    { label: 'GitHub', href: 'https://github.com/memrynote/memry' }
  ]
} as const

export const FEATURES = [
  {
    id: 'inbox',
    icon: Inbox,
    title: 'Inbox',
    tagline: 'Capture first, organize later.',
    description:
      'Every loose thought lands here first, then you snooze it, file it, or clear it in one pass.',
    highlights: ['Optional AI clustering', 'Quick capture', 'Snooze & file', 'Bulk actions'],
    screenshot: 'inbox'
  },
  {
    id: 'journal',
    icon: BookOpen,
    title: 'Journal',
    tagline: 'Reflect. Daily.',
    description:
      'One page a day. Your schedule and tasks sit beside it, so the writing has real context.',
    highlights: ['Day context sidebar', 'Time-based greetings', 'Templates', 'Beautiful writing'],
    screenshot: 'journal'
  },
  {
    id: 'notes',
    icon: FileText,
    title: 'Notes',
    tagline: 'Your second brain, in Markdown.',
    description:
      'Plain markdown files you own. Wiki-links connect them; backlinks show what points back.',
    highlights: ['[[Wiki links]]', 'Backlinks', '8 property types', 'Version history'],
    screenshot: 'notes'
  },
  {
    id: 'tasks',
    icon: CheckSquare,
    title: 'Tasks',
    tagline: 'From thought to done.',
    description:
      'The same tasks as a list, a board, or a calendar. Subtasks, recurrence, filters that stick.',
    highlights: ['Kanban/Calendar/List', 'Subtasks', 'Recurring tasks', 'Smart filters'],
    screenshot: 'tasks'
  },
  {
    id: 'calendar',
    icon: Calendar,
    title: 'Calendar',
    tagline: 'Your time, all in one place.',
    description:
      'Meetings, deadlines, tasks and journal days share one grid. Google sync runs both ways.',
    highlights: ['Google Calendar sync', 'Week view', 'Drag to reschedule', 'Start + due dates'],
    screenshot: 'calendar'
  }
] as const

export const FAQ_ITEMS = [
  {
    question: 'Is memrynote free?',
    answer:
      'Yes. The desktop app is free for local use with no account required. Plus, Pro, and Believer are only for hosted encrypted sync.'
  },
  {
    question: 'Where is my data stored?',
    answer:
      'Your data lives in a "vault" folder on your computer that you choose. Notes are stored as plain Markdown files with YAML frontmatter for metadata. You can open them in any text editor.'
  },
  {
    question: 'Is my data secure?',
    answer:
      'Yes. Your local vault stays on your device. When you use paid Sync, everything is encrypted end-to-end before upload. Only your devices can read your content.'
  },
  {
    question: 'Can I sync between devices?',
    answer:
      'Yes. Hosted memrynote Sync is paid and end-to-end encrypted. You can also keep the app local and use your own folder sync setup if that fits your workflow.'
  },
  {
    question: 'Is there a mobile app?',
    answer:
      'Desktop first (macOS, Windows, Linux) to nail the experience. Mobile apps for iOS and Android are targeting late 2026. In the meantime, your vault folder syncs with any cloud service you already use.'
  },
  {
    question: 'What file format does memrynote use?',
    answer:
      'Standard Markdown with YAML frontmatter for properties. Your notes are 100% portable and can be read by any Markdown-compatible app like Obsidian, iA Writer, or even VS Code.'
  },
  {
    question: 'Can I import from other apps?',
    answer:
      'Yes! We will support importing from Obsidian (direct vault), Notion (export), Roam Research, and plain Markdown folders. Your existing knowledge base can move with you.'
  },
  {
    question: 'Is memrynote available now?',
    answer:
      'Yes. The desktop app is available now — download the free, local-first app for macOS, Windows, or Linux and pick a vault in under a minute.'
  }
] as const

export const ROADMAP_DATA = {
  releaseDate: 'Available now',
  earlyAccess: 'The desktop app is available now',
  phases: [
    {
      status: 'done' as const,
      title: 'Available now',
      caption: 'The local-first desktop workspace is already usable across the core flows.',
      items: [
        'Local vault with Markdown notes, backlinks, and global search',
        'Inbox capture for text, URLs, images, and voice',
        'Tasks, projects, subtasks, recurring rules, and multiple views',
        'Daily journal, calendar week view, and reminders',
        'End-to-end encrypted sync for notes and journals',
        'Web clipper for Chrome, Firefox, and Edge',
        'Importers for Obsidian, Notion, Roam, Bear, Evernote, and more',
        'Agent Chat, voice memos with transcription, and Memrynote CLI'
      ]
    },
    {
      status: 'in-progress' as const,
      title: 'Building now',
      caption: 'The next work is focused on wider clipping and agent reliability.',
      items: [
        'Safari web clipper support',
        'Browser store listing: Edge Add-ons',
        'Optional AI Agent polish: provider settings, streaming, approvals'
      ]
    },
    {
      status: 'planned' as const,
      title: 'Planned next',
      caption: 'Direction, not a release promise. These unlock more ways to use your vault.',
      items: [
        'Mobile apps for iPhone, iPad, and Android (targeting late 2026)',
        'iPad handwriting and PDF annotation',
        'Offline mobile vault with conflict-safe sync',
        'Mobile share sheet, widgets, and quick capture',
        'Locked spaces for sensitive notes',
        'Public and shared vaults',
        'Plugin API for custom tools and views',
        'Templates marketplace',
        'Self-hosted encrypted sync server'
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
      'Stop context-switching between Notion, Todoist, and a journal app. memrynote connects your research, tasks, and daily reflections in one local-first workspace — with wiki-links that actually build a knowledge graph.',
    features: [
      'Optional AI-powered inbox clustering',
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
      "Capture first, organize later. The Inbox holds your thoughts so your brain doesn't have to. Zero-friction quick capture means nothing slips through — and optional AI clustering helps you make sense of the chaos when you're ready.",
    features: [
      'Zero-friction Inbox capture',
      'Optional AI clustering for brain dumps',
      'Gentle daily Journal ritual',
      'No forced organization'
    ],
    workflow: [
      'Brain-dump into Inbox',
      'Turn on AI to group related thoughts',
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

export type CheckoutPlanId = 'plus' | 'pro' | 'believer'
export type SyncPlanId = 'free' | CheckoutPlanId

export type SyncPlanEmphasis = 'standard' | 'recommended' | 'founding'

export type SyncPlanTier = {
  id: SyncPlanId
  name: string
  tagline: string
  monthlyPrice: number | null
  annualPrice: number | null
  annualMonthlyEquivalent: number | null
  lifetimePrice: number | null
  features: readonly string[]
  cta: string
  emphasis: SyncPlanEmphasis
  checkoutPlanId?: CheckoutPlanId
  ribbon?: string
}

export const SYNC_PLAN_TIERS: readonly SyncPlanTier[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'All local features.',
    monthlyPrice: 0,
    annualPrice: null,
    annualMonthlyEquivalent: null,
    lifetimePrice: null,
    features: [
      'Notes, tasks, inbox, and journal',
      'Local vault on your device',
      'Full-text search',
      'Markdown export',
      'No account required'
    ],
    cta: 'Start free',
    emphasis: 'standard'
  },
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'One vault, encrypted, everywhere.',
    monthlyPrice: 5,
    annualPrice: 48,
    annualMonthlyEquivalent: 4,
    lifetimePrice: null,
    features: [
      'Everything in Free',
      'End-to-end encrypted sync',
      'Unlimited devices on one account',
      '1 GB encrypted sync storage',
      '1 synced vault',
      '5 MB per file',
      '30 days of version history',
      'Server never sees plaintext',
      '14-day money-back guarantee'
    ],
    cta: 'Get Plus',
    emphasis: 'standard',
    checkoutPlanId: 'plus'
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'More room for serious sync.',
    monthlyPrice: 10,
    annualPrice: 96,
    annualMonthlyEquivalent: 8,
    lifetimePrice: null,
    features: [
      'Everything in Plus',
      '10 GB encrypted sync storage',
      '10 synced vaults',
      '200 MB per file',
      '365 days of version history',
      'Priority support — straight from the founder'
    ],
    cta: 'Get Pro',
    emphasis: 'recommended',
    checkoutPlanId: 'pro',
    ribbon: 'Most popular'
  },
  {
    id: 'believer',
    name: 'Believer',
    tagline: 'Support memrynote.',
    monthlyPrice: null,
    annualPrice: null,
    annualMonthlyEquivalent: null,
    lifetimePrice: 500,
    features: [
      'Everything in Pro',
      '50 GB encrypted sync storage',
      'Unlimited vaults',
      '200 MB per file',
      '365 days of version history',
      'Early access to new features',
      'Your name in the credits',
      'Help keep memrynote independent',
      'Direct line to the founder',
      'Limited slots'
    ],
    cta: 'Become a Believer',
    emphasis: 'founding',
    checkoutPlanId: 'believer',
    ribbon: 'Founding supporter'
  }
] as const

export type PlanComparisonValue = string | boolean

export const PLAN_COMPARISON_MATRIX = {
  plans: ['free', 'plus', 'pro', 'believer'] as const,
  sections: [
    {
      title: 'Core features',
      rows: [
        {
          feature: 'Create notes, tasks, save links & files',
          free: true,
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Local-first desktop app',
          free: true,
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Full-text search',
          free: true,
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Sync across your devices',
          free: false,
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Cloud backup & end-to-end encryption',
          free: false,
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Version history',
          free: false,
          plus: '30 days',
          pro: '365 days',
          believer: '365 days'
        }
      ]
    },
    {
      title: 'Storage & uploads',
      rows: [
        {
          feature: 'Encrypted sync storage',
          free: 'Local only',
          plus: '1 GB',
          pro: '10 GB',
          believer: '50 GB'
        },
        {
          feature: 'File upload limit',
          free: 'Local only',
          plus: '5 MB',
          pro: '200 MB',
          believer: '200 MB'
        },
        {
          feature: 'Synced vaults',
          free: 'Local only',
          plus: '1',
          pro: '10',
          believer: 'Unlimited'
        },
        {
          feature: 'Devices',
          free: '1 device',
          plus: 'Unlimited',
          pro: 'Unlimited',
          believer: 'Unlimited'
        }
      ]
    },
    {
      title: 'Optional AI features',
      rows: [
        {
          feature: 'AI assistant',
          free: 'Coming soon',
          plus: 'Coming soon',
          pro: 'Coming soon',
          believer: 'Early access'
        },
        {
          feature: 'AI search',
          free: 'Coming soon',
          plus: 'Coming soon',
          pro: 'Coming soon',
          believer: 'Early access'
        },
        {
          feature: 'AI suggestions',
          free: 'Coming soon',
          plus: 'Coming soon',
          pro: 'Coming soon',
          believer: 'Early access'
        },
        {
          feature: 'Latest AI models',
          free: false,
          plus: false,
          pro: 'Planned',
          believer: 'Early access'
        }
      ]
    },
    {
      title: 'Sharing & security',
      rows: [
        {
          feature: 'Markdown export',
          free: true,
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Server never sees plaintext',
          free: 'Local only',
          plus: true,
          pro: true,
          believer: true
        },
        {
          feature: 'Publishing',
          free: 'Planned',
          plus: 'Planned',
          pro: 'Planned',
          believer: 'Early access'
        },
        {
          feature: 'Collaboration',
          free: 'Planned',
          plus: 'Planned',
          pro: 'Planned',
          believer: 'Early access'
        }
      ]
    },
    {
      title: 'Extras',
      rows: [
        {
          feature: 'Priority support',
          free: false,
          plus: false,
          pro: true,
          believer: true
        },
        {
          feature: 'Priority access to new features',
          free: false,
          plus: false,
          pro: false,
          believer: true
        },
        {
          feature: 'Name in the credits',
          free: false,
          plus: false,
          pro: false,
          believer: true
        },
        {
          feature: 'Support independent software',
          free: true,
          plus: true,
          pro: true,
          believer: true
        }
      ]
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
    id: 'paused',
    label: 'Payment inactive',
    days: 'Immediately',
    description: 'Hosted sync pauses and returns 402. The desktop app keeps working locally.',
    tone: 'amber'
  },
  {
    id: 'local',
    label: 'Local access',
    days: 'Always',
    description: 'Your vault remains usable on disk. Sign in again only when you want hosted sync.',
    tone: 'terracotta'
  },
  {
    id: 'history-plus',
    label: 'Plus history',
    days: '30 days',
    description: 'Encrypted deleted-item history is retained for the Plus recovery window.',
    tone: 'terracotta-dim'
  },
  {
    id: 'history-pro',
    label: 'Pro / Believer history',
    days: '365 days',
    description: 'Pro and Believer keep the encrypted history window for a full year.',
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
      'Hosted sync pauses immediately until billing is active again. The local app keeps working with no account requirement; re-activate Sync from the app when you want devices connected again.'
  },
  {
    question: 'You store my data, but you cannot read it. What does that actually mean?',
    answer:
      'Every byte is encrypted on your device with XChaCha20-Poly1305 before it leaves. The keys live in your password manager and never touch our servers. We hold ciphertext, count bytes for billing, and that is the limit of what we see.'
  },
  {
    question: 'How does the refund policy work?',
    answer:
      '14-day money-back guarantee on every plan, including Believer. Request it inside the app — Paddle processes the refund back to your original payment method, no questions asked.'
  },
  {
    question: 'What is the Believer tier really?',
    answer:
      'A supporter package. You get everything in Pro, 50 GB of encrypted sync storage, unlimited vaults, early access to new features, your name in the credits, and the satisfaction of helping keep memrynote independent.'
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
    competitors: [{ name: 'memrynote', logo: '/favicon.svg' }]
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
      { name: 'Evernote', logo: '/competitors/evernote.png' },
      { name: 'Obsidian', logo: '/competitors/obsidian.png' }
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
