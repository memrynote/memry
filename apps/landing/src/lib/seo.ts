import { FAQ_ITEMS, FEATURES, GITHUB_URL, REDDIT_URL, TWITTER_DEV_URL } from './constants'

export const BASE_URL = 'https://memrynote.com'
export const SITE_NAME = 'memrynote'
export const ALTERNATE_SITE_NAMES = ['Memry Note', 'memrynote.com'] as const
// Brand handle (matches index.html). The founder's personal handle is TWITTER_DEV_URL in constants.
export const TWITTER_HANDLE = '@memrynote'
export const SOCIAL_IMAGE_PATH = '/og-image.png'
export const SOCIAL_IMAGE_URL = `${BASE_URL}${SOCIAL_IMAGE_PATH}`
export const SOCIAL_IMAGE_WIDTH = '1200'
export const SOCIAL_IMAGE_HEIGHT = '630'
export const SOCIAL_IMAGE_ALT =
  'memrynote social preview with the headline Your thoughts, beautifully organized.'

interface PageMeta {
  title: string
  description: string
  path: string
}

export const PAGE_META: Record<string, PageMeta> = {
  home: {
    title: 'memrynote — Notes, tasks & journal in one local-first app',
    description:
      'A local-first PKM that replaces your note app, task manager, and journal. Open source, end-to-end encrypted, yours forever.',
    path: '/'
  },
  features: {
    title: 'Features — memrynote',
    description:
      'Inbox, notes, tasks & journal — four pillars of thought in one app. Wiki-links, Kanban, daily journal, optional AI clustering, all local-first.',
    path: '/features'
  },
  notes: {
    title: 'Notes — memrynote',
    description:
      'A file-first, markdown-native notes app. Wiki-links, backlinks, 8 property types, version history. Plain .md files in a folder you own, local-first.',
    path: '/features/notes'
  },
  inbox: {
    title: 'Inbox — memrynote',
    description:
      'A contemplative space for processing what comes in. Quick capture, voice memos, web clips, PDF extraction, and optional AI-powered filing — all on your device.',
    path: '/features/inbox'
  },
  journal: {
    title: 'Journal — memrynote',
    description:
      'A reflective daily writing ritual. Day context sidebar, activity heatmap, time-based greetings, monthly stats, and templates. Reflect. Daily.',
    path: '/features/journal'
  },
  tasks: {
    title: 'Tasks — memrynote',
    description:
      'A multi-dimensional task system. Projects, custom statuses, subtasks, recurring schedules, Kanban / Calendar / List views, smart filters. From thought to done.',
    path: '/features/tasks'
  },
  calendar: {
    title: 'Calendar — memrynote',
    description:
      'The calendar view that knows about your tasks, deadlines, and journal entries. Drag-drop rescheduling, due and start dates, day overviews — all from your local vault.',
    path: '/features/calendar'
  },
  aiAgent: {
    title: 'AI Agent — memrynote (Coming soon)',
    description:
      'Optional AI for your second brain. Turn it on or off anytime. Local-first, BYOK, MCP-native, approval-gated writes, and local-model support.',
    path: '/features/ai-agent'
  },
  downloadDesktop: {
    title: 'memrynote for Desktop — macOS, Windows & Linux',
    description:
      'memrynote desktop for macOS, Windows, and Linux. Plain Markdown vault, end-to-end encrypted sync, open source.',
    path: '/download/desktop'
  },
  useCases: {
    title: 'Use Cases — memrynote',
    description:
      'Built for knowledge workers, students, freelancers, and personal productivity. One app that adapts to how you think.',
    path: '/use-cases'
  },
  security: {
    title: 'Security & Privacy — memrynote',
    description:
      'Local-first storage, XChaCha20-Poly1305 encryption, zero-knowledge sync, optional on-device AI. Your data never leaves your device unencrypted.',
    path: '/security'
  },
  pricing: {
    title: 'Pricing — memrynote Sync',
    description:
      'Local-first stays free, forever. Plus adds 1 GB sync, Pro adds 10 GB and 10 vaults, and Believer supports independent software with 50 GB and unlimited vaults.',
    path: '/pricing'
  },
  changelog: {
    title: 'Changelog — memrynote',
    description:
      'Follow the latest memrynote product updates, release notes, fixes, and shipped features.',
    path: '/changelog'
  },
  roadmap: {
    title: 'Roadmap — memrynote',
    description:
      'What is shipping now, what is planned next, and what we have already launched. We update this page as we ship.',
    path: '/roadmap'
  },
  terms: {
    title: 'Terms of Service — memrynote',
    description:
      'The agreement between you and memrynote when you use the local app and Sync service. Plain-English terms covering accounts, billing, lapse policy, and acceptable use.',
    path: '/terms'
  },
  privacy: {
    title: 'Privacy Policy — memrynote',
    description:
      'How memrynote handles your data. The local app collects nothing. Sync uploads only ciphertext encrypted on your device. Keys never touch our servers.',
    path: '/privacy'
  },
  refund: {
    title: 'Refund Policy — memrynote',
    description:
      'Seven-day money-back guarantee on every paid Sync plan, including Believer. Requests processed through Paddle, refunded to your original payment method.',
    path: '/refund'
  },
  obsidianAlternative: {
    title: 'Obsidian alternative — memrynote',
    description:
      'Looking for an Obsidian alternative with built-in tasks, a calendar, and end-to-end encrypted sync? memrynote keeps your notes as local Markdown files — no plugin tax.',
    path: '/obsidian-alternative'
  },
  notionAlternative: {
    title: 'Private Notion alternative — memrynote',
    description:
      'A private, end-to-end encrypted Notion alternative. memrynote stores notes as local Markdown files on your device — offline-first, open source, no vendor access to your data.',
    path: '/notion-alternative'
  },
  noteplanAlternative: {
    title: 'NotePlan alternative — memrynote',
    description:
      'A cross-platform NotePlan alternative for Windows, macOS, and Linux. Notes, tasks, calendar, and a daily journal in one local-first app with end-to-end encrypted sync.',
    path: '/noteplan-alternative'
  }
}

export const SITELINK_CANDIDATE_PATHS = [
  '/',
  '/features',
  '/pricing',
  '/download/desktop',
  '/changelog',
  '/roadmap'
] as const

export function getCanonicalUrl(path: string): string {
  return `${BASE_URL}${path}`
}

const ORGANIZATION_ID = `${BASE_URL}/#organization`

function getWebsiteJsonLdObject() {
  return {
    '@id': `${BASE_URL}/#website`,
    name: 'memrynote',
    alternateName: ALTERNATE_SITE_NAMES,
    url: `${BASE_URL}/`
  }
}

function getOrganizationJsonLdObject() {
  return {
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: 'memrynote',
    alternateName: ALTERNATE_SITE_NAMES,
    url: `${BASE_URL}/`,
    logo: {
      '@type': 'ImageObject',
      url: `${BASE_URL}/favicon.svg`
    },
    sameAs: [GITHUB_URL, TWITTER_DEV_URL, REDDIT_URL],
    founder: {
      '@type': 'Person',
      name: 'Kaan Karaca',
      sameAs: ['https://x.com/h4yfans', 'https://github.com/h4yfans']
    }
  }
}

const SCREENSHOT_CAPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['inbox', 'memrynote inbox'],
  ['journal', 'memrynote daily journal'],
  ['note', 'memrynote notes editor'],
  ['task', 'memrynote task management'],
  ['calendar', 'memrynote calendar view']
]

function getSoftwareApplicationJsonLdObject() {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${BASE_URL}/#app`,
    name: 'memrynote',
    applicationCategory: 'ProductivityApplication',
    applicationSubCategory: 'Personal Knowledge Management',
    operatingSystem: 'macOS, Windows, Linux',
    description: PAGE_META.home.description,
    url: `${BASE_URL}/`,
    downloadUrl: `${BASE_URL}/download/desktop`,
    screenshot: SCREENSHOT_CAPTIONS.map(([id, caption]) => ({
      '@type': 'ImageObject',
      url: `${BASE_URL}/screenshots/${id}_white.png`,
      caption
    })),
    featureList: [
      ...FEATURES.map((feature) => `${feature.title} — ${feature.tagline}`),
      'End-to-end encrypted sync',
      'Open source'
    ],
    creator: { '@id': ORGANIZATION_ID },
    publisher: { '@id': ORGANIZATION_ID },
    // aggregateRating and softwareVersion are intentionally omitted until a real rating
    // source and release tag exist — fabricating either violates Google's policies.
    offers: [
      {
        '@type': 'Offer',
        name: 'Free',
        price: '0',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        description: 'Free tier — notes, tasks, journal, inbox, and local vault'
      },
      {
        '@type': 'Offer',
        name: 'Plus',
        price: '5',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        description: 'Plus — 1 GB encrypted sync and 1 vault'
      },
      {
        '@type': 'Offer',
        name: 'Pro',
        price: '10',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        description: 'Pro — 10 GB encrypted sync and 10 vaults'
      },
      {
        '@type': 'Offer',
        name: 'Believer',
        price: '500',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        description: 'Believer — supporter package with 50 GB and unlimited vaults'
      }
    ]
  }
}

function getFaqPageJsonLdObject() {
  return {
    '@type': 'FAQPage',
    '@id': `${BASE_URL}/#faq`,
    // Google retired FAQ rich results (May 2026); this stays for AI-search citation
    // (Perplexity / ChatGPT / AI Overviews), since on-page answers live in a JS accordion.
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer
      }
    }))
  }
}

export function getWebsiteJsonLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    ...getWebsiteJsonLdObject(),
    '@type': 'WebSite'
  })
}

export function getJsonLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        ...getWebsiteJsonLdObject(),
        '@type': 'WebSite',
        publisher: { '@id': ORGANIZATION_ID }
      },
      getOrganizationJsonLdObject(),
      getSoftwareApplicationJsonLdObject(),
      getFaqPageJsonLdObject()
    ]
  })
}

function breadcrumbLabel(title: string): string {
  return title.split(' — ')[0]
}

// BreadcrumbList for inner pages. Intermediate segments without their own PAGE_META
// entry (e.g. /download) are skipped so no crumb links to a non-existent page.
export function getBreadcrumbJsonLd(page: keyof typeof PAGE_META): string | null {
  const meta = PAGE_META[page]
  if (!meta || meta.path === '/') return null

  const items: Array<{ '@type': 'ListItem'; position: number; name: string; item: string }> = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` }
  ]

  const segments = meta.path.split('/').filter(Boolean)
  let position = 2
  let acc = ''
  for (let i = 0; i < segments.length; i++) {
    acc += `/${segments[i]}`
    const isLeaf = i === segments.length - 1
    if (isLeaf) {
      items.push({
        '@type': 'ListItem',
        position: position++,
        name: breadcrumbLabel(meta.title),
        item: `${BASE_URL}${meta.path}`
      })
      continue
    }
    const parent = Object.values(PAGE_META).find((m) => m.path === acc)
    if (parent) {
      items.push({
        '@type': 'ListItem',
        position: position++,
        name: breadcrumbLabel(parent.title),
        item: `${BASE_URL}${acc}`
      })
    }
  }

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items
  })
}
