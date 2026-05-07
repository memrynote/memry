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
  { label: 'Roadmap', href: '#roadmap' },
  { label: 'Security', href: '/security' },
  { label: 'Docs', href: DOCS_URL }
] as const

export const FOOTER_LINKS = {
  product: [
    { label: 'Features', href: '#features' },
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
