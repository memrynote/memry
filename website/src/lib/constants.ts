import { Inbox, BookOpen, FileText, CheckSquare, FolderOpen, Lock, Zap } from 'lucide-react'

export const GITHUB_URL = 'https://github.com/memrynote/memry'
export const DISCORD_URL = 'https://discord.gg/memry'
export const TWITTER_DEV_URL = 'https://x.com/h4yfans'

export const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Roadmap', href: '#roadmap' },
  { label: 'Pricing', href: '#pricing' }
] as const

export const FOOTER_LINKS = {
  product: [
    { label: 'Features', href: '#features' },
    { label: 'Roadmap', href: '#roadmap' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'Download', href: '#waitlist' }
  ],
  resources: [
    { label: 'Blog', href: '#' },
    { label: 'Changelog', href: '#' },
    { label: 'Help Center', href: '#' }
  ],
  legal: [
    { label: 'Privacy', href: '#' },
    { label: 'Terms', href: '#' }
  ],
  social: [
    { label: 'Twitter', href: 'https://twitter.com/memrynote' },
    { label: 'Discord', href: '#' },
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
    description: "Local-first with E2EE. Your data is encrypted end-to-end. Even we can't read it."
  },
  {
    icon: Zap,
    title: 'Fast',
    description:
      'SQLite-powered instant search. Full-text search across all your notes in milliseconds.'
  }
] as const

export const FEATURES = [
  {
    id: 'inbox',
    icon: Inbox,
    title: 'Inbox',
    tagline: 'Capture first, organize later.',
    description:
      'A contemplative space for processing incoming information. AI-powered clustering detects related items and suggests bulk actions to reduce mental load.',
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
      obsidian: 'partial',
      logseq: 'partial'
    },
    { feature: 'Daily journal', memry: true, notion: 'partial', obsidian: 'partial', logseq: true },
    { feature: 'Inbox/capture', memry: true, notion: false, obsidian: false, logseq: false },
    { feature: 'Markdown files', memry: true, notion: false, obsidian: true, logseq: true },
    { feature: 'Free tier', memry: true, notion: 'partial', obsidian: true, logseq: true },
    {
      feature: 'End-to-end encryption',
      memry: true,
      notion: false,
      obsidian: true,
      logseq: false
    },
    {
      feature: 'Integrated experience',
      memry: true,
      notion: true,
      obsidian: false,
      logseq: 'partial'
    }
  ]
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
    price: '$9',
    period: '/month',
    yearlyPrice: '$79/year',
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
      'Absolutely. Your data is stored locally on your device by default. When you use Pro features like sync or collaboration, all data is encrypted end-to-end (E2EE) — meaning only you and the people you share with can read it. Not even we can access your content.'
  },
  {
    question: 'Can I sync between devices?',
    answer:
      "Absolutely! Since your vault is just a folder, you can use any sync service you prefer — iCloud, Dropbox, Google Drive, Syncthing, or even Git. We don't lock you into our own sync solution."
  },
  {
    question: 'Is there a mobile app?',
    answer:
      "We're focusing on desktop first (macOS, Windows, Linux) to get the experience right. A mobile companion app is planned for after the initial launch."
  },
  {
    question: 'What file format does Memry use?',
    answer:
      'Standard Markdown with YAML frontmatter for properties. Your notes are 100% portable and can be read by any Markdown-compatible app like Obsidian, iA Writer, or even VS Code.'
  },
  {
    question: 'Can I import from other apps?',
    answer:
      'Yes! We support importing from Obsidian (direct vault), Notion (export), Roam Research, and plain Markdown folders. Your existing knowledge base can move with you.'
  },
  {
    question: 'When will Memry launch?',
    answer:
      "We're targeting a public release in mid-2026. Join the waitlist to get early access and help shape the product. Waitlist members will be the first to know when we launch."
  }
] as const

export const ROADMAP_DATA = {
  releaseDate: 'Mid 2026',
  phases: [
    {
      status: 'done' as const,
      title: 'Core Foundation',
      items: [
        'Notes with Markdown & Wiki-links',
        'Backlinks & bidirectional linking',
        'Full-text search (FTS5)',
        'Tasks with projects & statuses',
        'Kanban & Calendar views',
        'Subtasks & recurring tasks',
        'Daily Journal with templates',
        'Quick capture Inbox',
        'File attachments & version history',
        '8 property types for metadata'
      ]
    },
    {
      status: 'in-progress' as const,
      title: 'Polish & AI',
      items: [
        'AI-powered inbox clustering',
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
        'Mobile companion app (iOS/Android)',
        'Graph view for note connections',
        'Plugin system & API',
        'Multi-vault support',
        'Import tools (Notion, Roam, Bear)',
        'Templates marketplace'
      ]
    }
  ]
} as const

export const COMPETITOR_TOOLS = [
  { id: 'notes', name: 'Note-taking app', price: 10, defaultSelected: true },
  { id: 'tasks', name: 'Task manager', price: 5, defaultSelected: true },
  { id: 'sync', name: 'Cloud sync service', price: 8, defaultSelected: false },
  { id: 'knowledge', name: 'Knowledge base', price: 12, defaultSelected: false },
  { id: 'pkm', name: 'Second brain tool', price: 15, defaultSelected: false },
  { id: 'journal', name: 'Daily journal app', price: 4, defaultSelected: false },
  { id: 'readlater', name: 'Read-later app', price: 5, defaultSelected: false },
  { id: 'bookmarks', name: 'Bookmark manager', price: 3, defaultSelected: false },
  { id: 'writing', name: 'Writing app', price: 5, defaultSelected: false },
  { id: 'habits', name: 'Habit tracker', price: 4, defaultSelected: false }
] as const
